/**
 * Plan orchestration: CID list -> piece commitments -> aggregates.
 *
 * All state lives in the SQLite database (see db.ts), so a run resumes after
 * interruption: `plan` computes commitments for CIDs that are not yet `done`,
 * then packs completed pieces into aggregates.
 */

import { packAggregates } from './aggregate.ts'
import type { MigrationDB } from './db.ts'
import { formatStageSummary, StageStats, Timer } from './metrics.ts'
import { categoryOf, fetchAndComputePiece } from './piece.ts'
import { log, pool } from './util.ts'

export interface PlanOptions {
  gateways: string[]
  aggregateSizeBytes: bigint
  concurrency: number
  ipfsFallback?: boolean
  fallbackTimeoutMs?: number
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
      const piece = await fetchAndComputePiece(cid, opts.gateways, {
        ipfsFallback: opts.ipfsFallback,
        fallbackTimeoutMs: opts.fallbackTimeoutMs,
      })
      const elapsed = timer.stop()
      stats.record(piece.rawSize, elapsed)
      db.recordPieceSuccess(cid, piece.pieceCid, piece.rawSize, piece.gateway, piece.url, piece.memberSha256)
      log(`  + ${cid} -> ${piece.pieceCid} (${piece.rawSize} bytes via ${piece.gateway}, ${Math.round(elapsed)}ms)`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      db.recordPieceFailure(cid, message, categoryOf(err))
    }
  })
  log(formatStageSummary('commP pass', stats.summary()))

  const oversized = repackPlanned(db, opts.aggregateSizeBytes)

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

  const oversizedCids = oversized.map((p) => p.cid)
  db.markOversized(oversizedCids)

  log(`Packed ${free.length} piece(s) into ${aggregates.length} planned aggregate(s).`)
  return oversizedCids
}

/**
 * After `pack-cars` builds sub-pieces, rebuild `planned` aggregates so their
 * members reference the packed sub-pieces instead of the original source CIDs.
 * Each unit (built sub-piece or still-free single-asset piece) becomes one
 * member; binning is by raw size against `aggregateSizeBytes`. Only planned
 * aggregates are replaced — submitted/parked/committed compositions are frozen.
 */
export function repackAfterPackCars(db: MigrationDB, aggregateSizeBytes: bigint): void {
  const subPieces = db.subPiecesByStatus('built')
  const free = db.donePiecesFreeForPacking()

  type Unit = { pieceCid: string; rawSize: number; cid: string; gateway: string; url: string; isSubPiece: boolean }
  const units: Unit[] = [
    ...subPieces.map((sp) => ({
      pieceCid: sp.subPieceCid,
      rawSize: sp.assembledCarLength,
      cid: sp.subPieceCid,
      gateway: '',
      url: '',
      isSubPiece: true,
    })),
    ...free.map((p) => ({
      pieceCid: p.pieceCid ?? '',
      rawSize: p.rawSize ?? 0,
      cid: p.cid,
      gateway: p.gateway ?? '',
      url: p.url ?? '',
      isSubPiece: false,
    })),
  ]

  const { aggregates, oversized } = packAggregates(units, aggregateSizeBytes)

  db.deletePlannedAggregates()
  const base = db.nextAggregateIndex()
  const subPieceSet = new Set(subPieces.map((s) => s.subPieceCid))
  aggregates.forEach((agg, i) => {
    db.saveAggregate(
      base + i,
      agg.rootPieceCid,
      aggregateSizeBytes,
      agg.members.map((m) => (subPieceSet.has(m.cid) ? { subPieceCid: m.cid } : { cid: m.cid }))
    )
  })

  const oversizedCids = oversized.filter((u) => !subPieceSet.has(u.cid)).map((u) => u.cid)
  db.markOversized(oversizedCids)

  log(
    `Repacked ${subPieces.length} sub-piece(s) + ${free.length} single-asset piece(s) ` +
      `into ${aggregates.length} planned aggregate(s).`
  )
}
