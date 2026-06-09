import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pieceAggregateCommP } from 'ipfs2foc-core/piece-aggregate'
import { MigrationDB } from '../src/db.ts'
import type { AddStatusResult, PullResponse } from '../src/pdp.ts'
import type { AddPiecesEvent } from '../src/pdp-verifier.ts'
import { runSubmitPdp, type SubmitDeps, type SubmitPdpOptions } from '../src/submit-pdp.ts'

// Drives the real runSubmitPdp control flow with a fake provider + chain, to
// lock in the atomicity guarantees (HIGH-1 at-most-once, MED-1 bounded polls,
// MED-3 continue-on-error) at the branch-selection level.

// Real PieceCIDs (from the fixture) so pieceAggregateCommP can parse heights.
const M1 = { pcid: 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa', raw: 5010728 }
const M2 = { pcid: 'bafkzcibewpkqwewyhz3yxutlxbpt2nkb6si5qilg4qqtzzij32uw7ammsc73a4wkgi', raw: 8131917 }

// A one-member aggregate's root is the member's pieceCid.
const rootOf = (pcid: string, raw: number) => pieceAggregateCommP([{ pieceCid: pcid, rawSize: raw }]).rootPieceCid

async function dbAt(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `foc-${name}-`))
  return { dir, db: new MigrationDB(join(dir, 'migrate.db')) }
}

function seedPlanned(db: MigrationDB, idx: number, src: string, m: { pcid: string; raw: number }) {
  db.addCids([src])
  db.recordPieceSuccess(src, m.pcid, m.raw, 'g', `https://gw/ipfs/${src}?format=car`, `sha-${src}`)
  db.recordPassthroughSubPiece({
    subPieceCid: m.pcid,
    sourceCid: src,
    url: `https://gw/ipfs/${src}?format=car`,
    rawSize: m.raw,
    memberSha256: null,
  })
  db.saveAggregate(idx, m.pcid, 32n * 1024n * 1024n * 1024n, [m.pcid])
}

interface FakeBehavior {
  pull?: (body: { pieces: Array<{ pieceCid: string }> }) => PullResponse | Promise<PullResponse>
  addAggregate?: () => { txHash: string; statusUrl: string }
  addStatus?: () => AddStatusResult
  activeRoots?: () => Set<string>
  event?: AddPiecesEvent | null
}

function fakeDeps(b: FakeBehavior) {
  const calls = { pull: 0, addAggregate: 0, addStatus: 0 }
  const deps: SubmitDeps = {
    async setup() {
      return {
        ctx: { presignForCommit: async () => '0xfake' },
        pdp: {
          async pull(body) {
            calls.pull++
            if (b.pull) return b.pull(body)
            return {
              status: 'complete',
              pieces: body.pieces.map((p) => ({ pieceCid: p.pieceCid, status: 'complete' })),
            }
          },
          async addAggregate() {
            calls.addAggregate++
            if (b.addAggregate) return b.addAggregate()
            return { txHash: '0xtx', statusUrl: '' }
          },
          async addStatus() {
            calls.addStatus++
            return b.addStatus ? b.addStatus() : { done: true, ok: true, confirmedPieceIds: [1] }
          },
        },
        minPieceSize: 0n,
        serviceURL: 'fake://provider',
      }
    },
    async activePieceCids() {
      return b.activeRoots ? b.activeRoots() : new Set<string>()
    },
    async fetchAddPiecesEvent() {
      return b.event ?? null
    },
    async getBaseFee() {
      return 0n
    },
  }
  return { deps, calls }
}

const baseOpts: SubmitPdpOptions = {
  privateKey: `0x${'11'.repeat(32)}`,
  network: 'calibration',
  dataSetId: 1,
  sourceBase: 'http://redirect.local',
  maxInFlight: 100,
  maxBaseFee: 10n ** 30n,
  pollMs: 1,
  pullBatch: 32,
}

async function withDb<T>(name: string, fn: (db: MigrationDB) => Promise<T>): Promise<T> {
  const { dir, db } = await dbAt(name)
  try {
    return await fn(db)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('happy path: pull -> add -> confirm -> committed', async () => {
  await withDb('flow-happy', async (db) => {
    seedPlanned(db, 0, 'bafSrc', M1)
    const root = rootOf(M1.pcid, M1.raw)
    const { deps, calls } = fakeDeps({
      event: { blockNumber: 100n, pieceIds: [7n], pieceCids: [root] },
    })
    await runSubmitPdp(db, baseOpts, deps)
    const agg = db.aggregates()[0]!
    assert.equal(agg.status, 'committed')
    assert.equal(calls.addAggregate, 1)
  })
})

test('HIGH-1: add errors with no tx hash and root NOT on chain -> add_unconfirmed, not failed, no re-add', async () => {
  await withDb('flow-500-absent', async (db) => {
    seedPlanned(db, 0, 'bafSrc', M1)
    const { deps, calls } = fakeDeps({
      addAggregate: () => {
        throw new Error('provider HTTP 500')
      },
      activeRoots: () => new Set(), // never lands
    })
    await runSubmitPdp(db, baseOpts, deps)
    const agg = db.aggregates()[0]!
    assert.equal(agg.status, 'add_unconfirmed', 'must not be failed (failed would be re-added)')
    assert.equal(calls.addAggregate, 1, 'add attempted exactly once')
  })
})

test('HIGH-1: add errors but the root IS on chain -> committed (reconciled)', async () => {
  await withDb('flow-500-landed', async (db) => {
    seedPlanned(db, 0, 'bafSrc', M1)
    const root = rootOf(M1.pcid, M1.raw)
    // Empty at the pre-add guard, present after the failed add -> exercises the
    // catch-path reconcile rather than the pre-add short-circuit.
    let seen = 0
    const { deps } = fakeDeps({
      addAggregate: () => {
        throw new Error('provider HTTP 500 after landing')
      },
      activeRoots: () => (seen++ === 0 ? new Set() : new Set([root])),
    })
    await runSubmitPdp(db, baseOpts, deps)
    assert.equal(db.aggregates()[0]?.status, 'committed')
  })
})

test('HIGH-1 resume: add_unconfirmed with no tx hash, root absent -> never re-adds', async () => {
  await withDb('flow-resume-absent', async (db) => {
    seedPlanned(db, 0, 'bafSrc', M1)
    db.markAggregateAddUnconfirmed(0, 'prior attempt, outcome unknown')
    const { deps, calls } = fakeDeps({ activeRoots: () => new Set() })
    await runSubmitPdp(db, baseOpts, deps)
    assert.equal(db.aggregates()[0]?.status, 'add_unconfirmed', 'stays unconfirmed')
    assert.equal(calls.addAggregate, 0, 'must NOT re-add (no duplicate AddPieces)')
  })
})

test('HIGH-1 resume: add_unconfirmed with no tx hash, root present -> reconciled to committed', async () => {
  await withDb('flow-resume-present', async (db) => {
    seedPlanned(db, 0, 'bafSrc', M1)
    db.markAggregateAddUnconfirmed(0, 'prior attempt, outcome unknown')
    const root = rootOf(M1.pcid, M1.raw)
    const { deps, calls } = fakeDeps({ activeRoots: () => new Set([root]) })
    await runSubmitPdp(db, baseOpts, deps)
    assert.equal(db.aggregates()[0]?.status, 'committed')
    assert.equal(calls.addAggregate, 0)
  })
})

test('MED-3: a pull error fails one aggregate and the run continues to the next', async () => {
  await withDb('flow-pull-continue', async (db) => {
    seedPlanned(db, 0, 'bafSrc0', M1)
    seedPlanned(db, 1, 'bafSrc1', M2)
    const { deps, calls } = fakeDeps({
      pull: () => {
        throw new Error('pull network error')
      },
    })
    await runSubmitPdp(db, baseOpts, deps)
    const [a0, a1] = db.aggregates()
    assert.equal(a0?.status, 'failed')
    assert.equal(a1?.status, 'failed', 'second aggregate was still processed (loop did not abort)')
    assert.equal(calls.addAggregate, 0)
  })
})

test('MED-1: an AddPieces that never confirms times out, leaving a resumable tx hash', async () => {
  await withDb('flow-confirm-timeout', async (db) => {
    seedPlanned(db, 0, 'bafSrc', M1)
    const { deps, calls } = fakeDeps({
      addStatus: () => ({ done: false, ok: false }), // never terminal
    })
    await runSubmitPdp(db, { ...baseOpts, addConfirmTimeoutMs: 5 }, deps)
    const agg = db.aggregates()[0]!
    assert.equal(agg.status, 'add_unconfirmed')
    assert.equal(agg.txHash, '0xtx', 'tx hash persisted so the next run resumes via the receipt branch')
    assert.equal(calls.addAggregate, 1)
  })
})

test('MED-1: a pull that never progresses trips the stall watchdog and fails the aggregate', async () => {
  await withDb('flow-pull-stall', async (db) => {
    seedPlanned(db, 0, 'bafSrc', M1)
    const { deps, calls } = fakeDeps({
      // Always non-terminal -> no progress -> stall.
      pull: (body) => ({
        status: 'pending',
        pieces: body.pieces.map((p) => ({ pieceCid: p.pieceCid, status: 'pending' })),
      }),
    })
    await runSubmitPdp(db, { ...baseOpts, pullStallTimeoutMs: 5 }, deps)
    const agg = db.aggregates()[0]!
    assert.equal(agg.status, 'failed')
    assert.match(agg.error ?? '', /stall/)
    assert.equal(calls.addAggregate, 0)
  })
})
