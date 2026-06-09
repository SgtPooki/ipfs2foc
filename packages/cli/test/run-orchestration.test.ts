import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pieceAggregateCommP } from 'ipfs2foc-core/piece-aggregate'
import { MigrationDB } from '../src/db.ts'
import { GatewayError } from '../src/gateway.ts'
import { type PieceFetcher, runPlan } from '../src/migrate.ts'
import type { ProofHealth } from '../src/pdp-verifier.ts'
import type { PieceResult } from '../src/piece.ts'
import { type ReportDeps, runReport } from '../src/report.ts'

// runPlan and runReport orchestration, driven with injected fakes — no gateway,
// no RPC.

const SRC1 = 'bafybeia2yt37rxkqu7ovw6ja3nf2aqatrzpcwh2tvl2kqbgeqcccn5evhy'
const PC1 = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'
const PC1_RAW = 5010728
const BIG = 32n * 1024n * 1024n * 1024n

async function dbAt(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `foc-${name}-`))
  return { dir, db: new MigrationDB(join(dir, 'migrate.db')) }
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

// --- runPlan ---

test('runPlan records a gateway success and appends an aggregate', async () => {
  await withDb('plan-ok', async (db) => {
    db.addCids([SRC1])
    const fetch: PieceFetcher = async (cid) => ({
      cid,
      pieceCid: PC1,
      rawSize: PC1_RAW,
      gateway: 'g',
      url: `https://g/ipfs/${cid}?format=car`,
      source: 'gateway',
      memberSha256: 's',
    })
    const summary = await runPlan(db, { gateways: ['g'], aggregateSizeBytes: BIG, concurrency: 1 }, fetch)
    assert.equal(summary.succeeded, 1)
    assert.equal(db.counts().done, 1)
    assert.equal(db.aggregates().length, 1)
  })
})

test('runPlan marks a fallback-only result as an unservable failure (no aggregate)', async () => {
  await withDb('plan-helia', async (db) => {
    db.addCids([SRC1])
    const fetch: PieceFetcher = async (cid): Promise<PieceResult> => ({
      cid,
      pieceCid: PC1,
      rawSize: 100,
      gateway: 'helia',
      url: '',
      source: 'helia',
      memberSha256: 's',
    })
    await runPlan(db, { gateways: ['g'], aggregateSizeBytes: BIG, concurrency: 1 }, fetch)
    assert.equal(db.counts().failed, 1)
    assert.equal(db.failuresByCategory().unservable_fallback_only, 1)
    assert.equal(db.aggregates().length, 0)
  })
})

test('runPlan records a thrown fetch as a failure', async () => {
  await withDb('plan-throw', async (db) => {
    db.addCids([SRC1])
    const fetch: PieceFetcher = async () => {
      throw new GatewayError('boom', { status: 500, category: 'source_gateway_5xx' })
    }
    await runPlan(db, { gateways: ['g'], aggregateSizeBytes: BIG, concurrency: 1 }, fetch)
    assert.equal(db.counts().failed, 1)
    assert.equal(db.failuresByCategory().source_gateway_5xx, 1)
  })
})

// --- runReport ---

function proofHealth(over: Partial<ProofHealth> = {}): ProofHealth {
  return {
    live: true,
    currentEpoch: 100n,
    lastProvenEpoch: 90n,
    nextChallengeEpoch: 200n,
    challengeFinality: 10n,
    activePieceCount: 1n,
    provenSinceAdd: false,
    inGoodStanding: false,
    ...over,
  }
}

function seedCommittedAggregate(db: MigrationDB) {
  db.addCids([SRC1])
  db.recordPieceSuccess(SRC1, PC1, PC1_RAW, 'g', `https://g/ipfs/${SRC1}?format=car`, 's')
  db.recordPassthroughSubPiece({ subPieceCid: PC1, sourceCid: SRC1, url: 'u', rawSize: PC1_RAW, memberSha256: null })
  db.saveAggregate(0, PC1, BIG, [PC1])
  db.markCommitted(0, { dataSetId: '1', txHash: '0xtx', pieceId: '1', committedBlock: '50' })
}

const root = () => pieceAggregateCommP([{ pieceCid: PC1, rawSize: PC1_RAW }]).rootPieceCid

test('runReport: root on chain + proven => committed and complete', async () => {
  await withDb('report-complete', async (db) => {
    seedCommittedAggregate(db)
    const deps: ReportDeps = {
      activePieceCids: async () => new Set([root()]),
      maxBlockOfTxHashes: async () => 50n,
      dataSetProofHealth: async () => proofHealth({ provenSinceAdd: true, inGoodStanding: true }),
    }
    const r = await runReport(db, { network: 'calibration', dataSetId: 1, rpcUrl: 'http://rpc.local' }, deps)
    assert.equal(r.cids.committed, 1)
    assert.equal(r.aggregates[0]?.onChain, true)
    assert.equal(r.complete, true)
    assert.deepEqual(r.discrepancies, [])
  })
})

test('runReport: not proven yet => not complete', async () => {
  await withDb('report-unproven', async (db) => {
    seedCommittedAggregate(db)
    const deps: ReportDeps = {
      activePieceCids: async () => new Set([root()]),
      maxBlockOfTxHashes: async () => 50n,
      dataSetProofHealth: async () => proofHealth({ provenSinceAdd: false, inGoodStanding: true }),
    }
    const r = await runReport(db, { network: 'calibration', dataSetId: 1, rpcUrl: 'http://rpc.local' }, deps)
    assert.equal(r.cids.committed, 1)
    assert.equal(r.complete, false)
  })
})

test('runReport: a chain root with no local aggregate is reported as unaccountedOnChain', async () => {
  await withDb('report-unaccounted', async (db) => {
    seedCommittedAggregate(db)
    const deps: ReportDeps = {
      // the local aggregate root is absent; an unrelated root is on chain
      activePieceCids: async () => new Set(['bafkzcibstrangerootnotours']),
      maxBlockOfTxHashes: async () => null,
      dataSetProofHealth: async () => proofHealth({ provenSinceAdd: true, inGoodStanding: true }),
    }
    const r = await runReport(db, { network: 'calibration', dataSetId: 1, rpcUrl: 'http://rpc.local' }, deps)
    assert.deepEqual(r.unaccountedOnChain, ['bafkzcibstrangerootnotours'])
    assert.equal(r.aggregates[0]?.onChain, false)
    assert.equal(r.complete, false)
    // local row says committed but chain disagrees -> surfaced
    assert.ok(r.discrepancies.some((d) => /committed locally but is not on chain/.test(d)))
  })
})
