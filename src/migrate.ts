/**
 * Plan orchestration: CID list -> piece commitments -> aggregates.
 *
 * All state lives in the SQLite database (see db.ts), so a run resumes after
 * interruption: `plan` computes commitments for CIDs that are not yet `done`,
 * then packs completed pieces into aggregates. Manifests for `sptool` come from
 * the database on demand (see exportManifest).
 */

import { packAggregates } from './aggregate.ts'
import type { MigrationDB } from './db.ts'
import { formatStageSummary, StageStats, Timer } from './metrics.ts'
import { fetchAndComputePiece } from './piece.ts'
import { log, pool } from './util.ts'

export interface PlanOptions {
  gateways: string[]
  aggregateSizeBytes: bigint
  concurrency: number
}

export interface PlanSummary {
  total: number
  succeeded: number
  failed: number
  aggregateCount: number
  oversized: string[]
}

/**
 * Compute piece commitments for all pending CIDs, then (re)pack every completed
 * piece into aggregates. Idempotent and resumable.
 */
export async function runPlan(db: MigrationDB, opts: PlanOptions): Promise<PlanSummary> {
  const pending = db.pendingCids()
  log(`Computing piece commitments for ${pending.length} pending CID(s) (concurrency ${opts.concurrency})...`)

  const stats = new StageStats()
  await pool(pending, opts.concurrency, async (cid) => {
    const timer = new Timer()
    try {
      const piece = await fetchAndComputePiece(cid, opts.gateways)
      const elapsed = timer.stop()
      stats.record(piece.rawSize, elapsed)
      db.recordPieceSuccess(cid, piece.pieceCid, piece.rawSize, piece.gateway, piece.url)
      log(`  + ${cid} -> ${piece.pieceCid} (${piece.rawSize} bytes via ${piece.gateway}, ${Math.round(elapsed)}ms)`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      db.recordPieceFailure(cid, message)
    }
  })
  log(formatStageSummary('commP pass', stats.summary()))

  const oversized = repackPlanned(db, opts.aggregateSizeBytes)

  const counts = db.counts()
  return {
    total: counts.pending + counts.processing + counts.done + counts.failed,
    succeeded: counts.done,
    failed: counts.failed,
    aggregateCount: db.aggregates().length,
    oversized,
  }
}

/**
 * Pack every completed piece that is not already locked into a submitted-or-later
 * aggregate. Replaces only the `planned` aggregates, so in-flight ones keep their
 * index and members. Returns the CIDs too large for one aggregate of this size.
 */
export function repackPlanned(db: MigrationDB, aggregateSizeBytes: bigint): string[] {
  const locked = db.lockedMemberCids()
  const free = db.donePieces().filter((p) => !locked.has(p.cid))

  const { aggregates, oversized } = packAggregates(
    free.map((p) => ({
      cid: p.cid,
      pieceCid: p.pieceCid ?? '',
      rawSize: p.rawSize ?? 0,
      gateway: p.gateway ?? '',
      url: p.url ?? '',
    })),
    aggregateSizeBytes
  )

  db.deletePlannedAggregates()
  const base = db.nextAggregateIndex()
  aggregates.forEach((agg, i) => {
    db.saveAggregate(base + i, agg.rootPieceCid, aggregateSizeBytes, agg.members.map((m) => m.cid))
  })

  log(`Packed ${free.length} piece(s) into ${aggregates.length} planned aggregate(s).`)
  return oversized.map((p) => p.cid)
}

/** Build the `sptool toolbox mk20-client --aggregate` manifest text for one aggregate. */
export function exportManifest(db: MigrationDB, idx: number): string {
  const rows = db.aggregateManifest(idx)
  if (rows.length === 0) {
    throw new Error(`aggregate ${idx} not found or empty`)
  }
  return rows.map((r) => `${r.pieceCid}\t${r.url}`).join('\n') + '\n'
}
