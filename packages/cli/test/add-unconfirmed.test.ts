import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'

// Atomicity guard (HIGH-1): an attempted-but-unconfirmed AddPieces must never be
// auto-reset into a blind re-add, which would land a duplicate on-chain commit
// for the same root.

async function dbAt(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `foc-${name}-`))
  return { dir, db: new MigrationDB(join(dir, 'migrate.db')) }
}

function seedParkedAggregate(db: MigrationDB, idx = 0) {
  db.addCids(['bafkreia'])
  db.recordPieceSuccess('bafkreia', 'bafkzcibe-piece', 100, 'g', 'u', 'sha-a')
  db.recordPassthroughSubPiece({
    subPieceCid: 'bafkzcibe-piece',
    sourceCid: 'bafkreia',
    url: 'u',
    rawSize: 100,
    memberSha256: null,
  })
  db.saveAggregate(idx, 'bafkzcibe-root', 256n, ['bafkzcibe-piece'])
  db.markParked(idx)
}

test('markAggregateAddUnconfirmed sets the durable status and records the reason', async () => {
  const { dir, db } = await dbAt('addunconf-set')
  try {
    seedParkedAggregate(db)
    db.markAggregateAddUnconfirmed(0, 'add errored: provider 500')
    const row = db.aggregates().find((a) => a.idx === 0)!
    assert.equal(row.status, 'add_unconfirmed')
    assert.match(row.error ?? '', /provider 500/)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('resetFailedAggregates does NOT re-arm an add_unconfirmed aggregate (no blind re-add)', async () => {
  const { dir, db } = await dbAt('addunconf-noreset')
  try {
    seedParkedAggregate(db)
    db.markAggregateAddUnconfirmed(0, 'outcome unknown')
    const changed = db.resetFailedAggregates()
    assert.equal(changed, 0, 'failed-reset must not touch unconfirmed rows')
    assert.equal(db.aggregates().find((a) => a.idx === 0)?.status, 'add_unconfirmed')
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('resetUnconfirmedAggregates re-arms to planned and clears the stale tx hash', async () => {
  const { dir, db } = await dbAt('addunconf-retry')
  try {
    seedParkedAggregate(db)
    db.markAggregateAddUnconfirmed(0, 'outcome unknown')
    db.markAggregateTxSubmitted(0, '0xstale')
    const changed = db.resetUnconfirmedAggregates()
    assert.equal(changed, 1)
    const row = db.aggregates().find((a) => a.idx === 0)!
    assert.equal(row.status, 'planned')
    assert.equal(row.txHash, null, 'stale tx hash cleared so the re-add is fresh')
    assert.equal(row.error, null)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unconfirmed aggregate counts as in-flight and is picked up for receipt resume', async () => {
  const { dir, db } = await dbAt('addunconf-inflight')
  try {
    seedParkedAggregate(db)
    db.markAggregateAddUnconfirmed(0, 'awaiting confirmation')
    assert.equal(db.inFlightUncommittedCount(), 1, 'unresolved add occupies an in-flight slot')
    // With a tx hash, it must surface for receipt-based resume.
    db.markAggregateTxSubmitted(0, '0xpending')
    const awaiting = db.aggregatesAwaitingReceipt()
    assert.equal(awaiting.length, 1)
    assert.equal(awaiting[0]?.txHash, '0xpending')
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
