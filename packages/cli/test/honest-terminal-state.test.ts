import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'
import { appendAggregatesFromFreeSubPieces, wrapDonePiecesAsPassthroughSubPieces } from '../src/migrate.ts'
import { type PieceResult, recordPieceOutcome } from '../src/piece.ts'
import { computeReportComplete } from '../src/report.ts'

// A real PieceCID v2 (from test/fixtures/multi-asset-aggregate.json) so
// `paddedSize` can parse its tree height.
const REAL_PIECE_CID = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'

async function dbAt(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `foc-${name}-`))
  return { dir, db: new MigrationDB(join(dir, 'migrate.db')) }
}

// --- H2: fallback-only pieces are not recorded as a migratable success ---

test('recordPieceOutcome records a gateway-served piece as done', async () => {
  const { dir, db } = await dbAt('outcome-gw')
  try {
    db.addCids(['bafGw'])
    const piece: PieceResult = {
      cid: 'bafGw',
      pieceCid: 'pcGw',
      rawSize: 100,
      gateway: 'https://gw',
      url: 'https://gw/ipfs/bafGw?format=car',
      memberSha256: 'sha',
      source: 'gateway',
    }
    recordPieceOutcome(db, 'bafGw', piece)
    const counts = db.counts()
    assert.equal(counts.done, 1)
    assert.equal(counts.failed, 0)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('recordPieceOutcome records a fallback-only piece as failed (unservable_fallback_only), not done', async () => {
  const { dir, db } = await dbAt('outcome-helia')
  try {
    db.addCids(['bafHelia'])
    const piece: PieceResult = {
      cid: 'bafHelia',
      pieceCid: 'pcHelia',
      rawSize: 100,
      gateway: 'helia',
      url: '',
      memberSha256: 'sha',
      source: 'helia',
    }
    recordPieceOutcome(db, 'bafHelia', piece)
    const counts = db.counts()
    assert.equal(counts.done, 0, 'must not be a done success')
    assert.equal(counts.failed, 1)
    assert.equal(db.failuresByCategory().unservable_fallback_only, 1)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// --- M1: completeness includes oversized, and requires a proof ---

test('computeReportComplete is false when CIDs are oversized', () => {
  assert.equal(
    computeReportComplete({
      unaccounted: 0,
      pendingNotCommitted: 0,
      failed: 0,
      oversized: 2,
      unaccountedOnChain: 0,
      provenSinceAdd: true,
      inGoodStanding: true,
    }),
    false
  )
})

test('computeReportComplete is true only when everything is accounted and proven', () => {
  const base = {
    unaccounted: 0,
    pendingNotCommitted: 0,
    failed: 0,
    oversized: 0,
    unaccountedOnChain: 0,
    provenSinceAdd: true,
    inGoodStanding: true,
  }
  assert.equal(computeReportComplete(base), true)
  assert.equal(computeReportComplete({ ...base, provenSinceAdd: false }), false)
  assert.equal(computeReportComplete({ ...base, inGoodStanding: false }), false)
  assert.equal(computeReportComplete({ ...base, failed: 1 }), false)
  assert.equal(computeReportComplete({ ...base, pendingNotCommitted: 1 }), false)
})

// --- H1: oversized sub-pieces mark their source CIDs oversized (not stuck done) ---

test('appendAggregatesFromFreeSubPieces marks oversized source CIDs and resetOversized re-arms them', async () => {
  const { dir, db } = await dbAt('oversized')
  try {
    db.addCids(['bafBig'])
    recordPieceOutcome(db, 'bafBig', {
      cid: 'bafBig',
      pieceCid: REAL_PIECE_CID,
      rawSize: 5010728,
      gateway: 'g',
      url: 'https://g/ipfs/bafBig?format=car',
      memberSha256: 'sha',
      source: 'gateway',
    })
    wrapDonePiecesAsPassthroughSubPieces(db)

    // Budget of 1 byte: every real piece's padded size exceeds it -> oversized.
    const oversized = appendAggregatesFromFreeSubPieces(db, 1n)
    assert.deepEqual(oversized, ['bafBig'], 'returns the source CID, not the sub-piece CID')
    assert.equal(db.counts().oversized, 1)
    assert.equal(db.counts().done, 0, 'no longer counted as done/pending')

    // Re-packing at a larger budget re-arms it for aggregation.
    db.resetOversized()
    assert.equal(db.counts().oversized, 0)
    assert.equal(db.counts().done, 1)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
