import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'

async function dbAt(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `foc-${name}-`))
  return { dir, db: new MigrationDB(join(dir, 'migrate.db')) }
}

function seedSubmittedAggregate(db: MigrationDB) {
  db.addCids(['bafkreia'])
  db.recordPieceSuccess('bafkreia', 'bafkzcibe-piece', 100, 'g', 'u', 'sha-a')
  // saveAggregate now takes sub_piece_cids only. Wrap the source as a
  // passthrough sub-piece first, then point the aggregate at that sub-piece.
  db.recordPassthroughSubPiece({
    subPieceCid: 'bafkzcibe-piece',
    sourceCid: 'bafkreia',
    url: 'u',
    rawSize: 100,
    memberSha256: null,
  })
  db.saveAggregate(0, 'bafkzcibe-root', 256n, ['bafkzcibe-piece'])
  db.markSubmitted(0, 'pull-0')
}

test('markAggregateTxSubmitted persists tx_hash without flipping to committed', async () => {
  const { dir, db } = await dbAt('tx-set')
  try {
    seedSubmittedAggregate(db)
    db.markAggregateTxSubmitted(0, '0xabc123')
    const row = db.aggregates().find((a) => a.idx === 0)!
    assert.equal(row.txHash, '0xabc123')
    assert.notEqual(row.status, 'committed')
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('aggregateAwaitingReceipt returns rows with a tx_hash but no commit yet', async () => {
  const { dir, db } = await dbAt('await')
  try {
    seedSubmittedAggregate(db)
    db.markAggregateTxSubmitted(0, '0xpending')
    const rows = db.aggregatesAwaitingReceipt()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.txHash, '0xpending')
    db.markCommitted(0, { dataSetId: '1', txHash: '0xpending', pieceId: '7', committedBlock: '100' })
    assert.deepEqual(db.aggregatesAwaitingReceipt(), [])
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
