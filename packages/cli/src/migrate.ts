/**
 * Plan orchestration: CID list → piece commitments → passthrough sub-pieces →
 * aggregates.
 *
 * `plan` computes piece commitments for every pending source CID and wraps
 * each successful commitment as a passthrough sub-piece (one member CID,
 * `url` set to the source-gateway URL, no CAR file on disk). Aggregates are
 * appended over the newly available sub-pieces. Everything is INSERT-only:
 * rerunning `plan` after adding CIDs adds new pieces, sub-pieces, and
 * aggregates without touching prior state.
 */

import { packAggregates } from './aggregate.ts'
import type { MigrationDB } from './db.ts'
import { formatStageSummary, StageStats, Timer } from './metrics.ts'
import { categoryOf, fetchAndComputePiece, recordPieceOutcome } from './piece.ts'
import { log, pool } from './util.ts'

export interface PlanOptions {
  gateways: string[]
  aggregateSizeBytes: bigint
  concurrency: number
  ipfsFallback?: boolean
  fallbackTimeoutMs?: number
  /**
   * Default true. When false, `plan` stops after commP — the operator is
   * expected to run `pack-cars` (multi-asset) before `pdp-submit`. Set
   * `--no-auto-pack` on the CLI when packing multiple source CIDs into one
   * sub-piece is intended.
   */
  autoPack?: boolean
}

export interface PlanSummary {
  total: number
  succeeded: number
  failed: number
  aggregateCount: number
  oversized: string[]
}

/**
 * Compute commitments, wrap each as a passthrough sub-piece, append aggregates
 * over the un-aggregated sub-piece set. Idempotent: pieces already done, sub-
 * pieces already recorded, and aggregates already created are left alone.
 */
/** The piece fetcher `runPlan` drives; injectable so the plan loop is testable
 *  without a gateway. Defaults to the real {@link fetchAndComputePiece}. */
export type PieceFetcher = typeof fetchAndComputePiece

export async function runPlan(
  db: MigrationDB,
  opts: PlanOptions,
  fetchPiece: PieceFetcher = fetchAndComputePiece
): Promise<PlanSummary> {
  const pending = db.pendingCids()
  log(`Computing piece commitments for ${pending.length} pending CID(s) (concurrency ${opts.concurrency})...`)

  const stats = new StageStats()
  await pool(pending, opts.concurrency, async (cid) => {
    const timer = new Timer()
    try {
      const piece = await fetchPiece(cid, opts.gateways, {
        ipfsFallback: opts.ipfsFallback,
        fallbackTimeoutMs: opts.fallbackTimeoutMs,
      })
      const elapsed = timer.stop()
      stats.record(piece.rawSize, elapsed)
      recordPieceOutcome(db, cid, piece)
      log(`  + ${cid} -> ${piece.pieceCid} (${piece.rawSize} bytes via ${piece.gateway}, ${Math.round(elapsed)}ms)`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      db.recordPieceFailure(cid, message, categoryOf(err))
    }
  })
  log(formatStageSummary('commP pass', stats.summary()))

  const autoPack = opts.autoPack !== false
  let oversized: string[] = []
  if (autoPack) {
    wrapDonePiecesAsPassthroughSubPieces(db)
    oversized = appendAggregatesFromFreeSubPieces(db, opts.aggregateSizeBytes)
  }

  const counts = db.counts()
  return {
    total: counts.total,
    succeeded: counts.done,
    failed: counts.failed,
    aggregateCount: db.aggregates().length,
    oversized,
  }
}

/**
 * Wrap every successful piece that is not already a sub-piece member as a
 * passthrough sub-piece. The sub-piece's PieceCID equals the source piece's
 * PieceCID; the pull source is the gateway URL captured at commP time.
 * Skips pieces already wrapped (resumable / re-runnable).
 */
export function wrapDonePiecesAsPassthroughSubPieces(db: MigrationDB): void {
  const free = db.donePiecesFreeForPacking()
  const noGatewayUrl: string[] = []
  for (const p of free) {
    if (p.pieceCid == null || p.rawSize == null) continue
    // A piece fetched only through the IPFS fallback has no gateway URL to
    // 302 to (gateway === 'helia', url === ''). The provider pull is HTTP-only,
    // so such a piece cannot be served as a passthrough sub-piece and pack-cars
    // (HTTP re-fetch) cannot assemble it either. Surface it instead of dropping
    // it silently — leaving it unmigrated with no warning is the worse failure.
    if (p.url == null || p.url === '') {
      noGatewayUrl.push(p.cid)
      continue
    }
    db.recordPassthroughSubPiece({
      subPieceCid: p.pieceCid,
      sourceCid: p.cid,
      url: p.url,
      rawSize: p.rawSize,
      memberSha256: null,
    })
  }
  if (noGatewayUrl.length > 0) {
    log(
      `! ${noGatewayUrl.length} piece(s) resolved only via the IPFS fallback and have no ` +
        `gateway URL for the provider to pull from; they were NOT wrapped and will not ` +
        `migrate: ${noGatewayUrl.join(', ')}`
    )
  }
}

/**
 * Append new planned aggregates over every built sub-piece that is not yet
 * part of an aggregate. Existing aggregates are never deleted — composition
 * is set at INSERT and frozen for the row's lifetime.
 */
export function appendAggregatesFromFreeSubPieces(db: MigrationDB, aggregateSizeBytes: bigint): string[] {
  const aggregated = db.subPieceCidsAlreadyAggregated()
  const subPieces = db.subPiecesByStatus('built').filter((sp) => !aggregated.has(sp.subPieceCid))
  if (subPieces.length === 0) return []

  const units = subPieces.map((sp) => ({
    cid: sp.subPieceCid,
    pieceCid: sp.subPieceCid,
    rawSize: sp.assembledCarLength,
    gateway: '',
    url: sp.url ?? '',
  }))

  const { aggregates, oversized } = packAggregates(units, aggregateSizeBytes)

  const base = db.nextAggregateIndex()
  aggregates.forEach((agg, i) => {
    db.saveAggregate(
      base + i,
      agg.rootPieceCid,
      aggregateSizeBytes,
      agg.members.map((m) => m.cid)
    )
  })

  // A sub-piece whose padded size exceeds the aggregate budget can never be
  // packed at this `--piece-size`. Mark its source CIDs `oversized` (a terminal
  // status, distinct from a transient `done`) so `report` surfaces them instead
  // of counting them as pending forever. `resetOversized` re-arms them when the
  // operator re-packs at a larger size.
  const oversizedSourceCids = oversized.flatMap((p) => db.subPieceMemberCids(p.cid))
  if (oversizedSourceCids.length > 0) db.markOversized(oversizedSourceCids)

  log(`Appended ${aggregates.length} planned aggregate(s) over ${subPieces.length} free sub-piece(s).`)
  return oversizedSourceCids
}
