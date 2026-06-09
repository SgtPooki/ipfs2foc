import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'

// M3: a source CID committed via two aggregates (e.g. a passthrough and a packed
// aggregate over the same source) must be counted once, not twice.

async function dbAt(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `foc-${name}-`))
  return { dir, db: new MigrationDB(join(dir, 'migrate.db')) }
}

test('committedSourceCidStats dedupes a CID that appears in two on-chain aggregates', async () => {
  const { dir, db } = await dbAt('acct-dedup')
  try {
    db.addCids(['bafX'])
    db.recordPieceSuccess('bafX', 'pcX', 100, 'g', 'https://g/ipfs/bafX?format=car', 'shaX')

    // Same source CID in a passthrough sub-piece and a packed sub-piece.
    db.recordPassthroughSubPiece({
      subPieceCid: 'ppX',
      sourceCid: 'bafX',
      url: 'https://g/ipfs/bafX?format=car',
      rawSize: 100,
      memberSha256: null,
    })
    db.recordBuiltSubPiece({
      subPieceCid: 'packX',
      assembledCarLength: 100,
      targetSizeBytes: 256,
      carPath: '/tmp/packX.car',
      assembledSha256: 'sha-pack',
      members: [{ cid: 'bafX', rawSize: 100, sha256: 'shaX' }],
    })

    // Two aggregates, each over one of those sub-pieces.
    db.saveAggregate(0, 'root0', 256n, ['ppX'])
    db.saveAggregate(1, 'root1', 256n, ['packX'])

    // Both on chain -> the source CID is still counted once.
    const stats = db.committedSourceCidStats([0, 1])
    assert.equal(stats.total, 1, 'distinct source CIDs, not summed memberCounts')
    assert.equal(stats.inPieces, 1)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('committedSourceCidStats is empty when no aggregates are on chain', async () => {
  const { dir, db } = await dbAt('acct-empty')
  try {
    assert.deepEqual(db.committedSourceCidStats([]), { inPieces: 0, total: 0 })
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('committedSourceCidStats counts distinct source CIDs across a multi-asset aggregate', async () => {
  const { dir, db } = await dbAt('acct-multi')
  try {
    db.addCids(['bafA', 'bafB'])
    db.recordPieceSuccess('bafA', 'pcA', 100, 'g', 'uA', 'shaA')
    db.recordPieceSuccess('bafB', 'pcB', 200, 'g', 'uB', 'shaB')
    db.recordBuiltSubPiece({
      subPieceCid: 'packAB',
      assembledCarLength: 300,
      targetSizeBytes: 256,
      carPath: '/tmp/packAB.car',
      assembledSha256: 'sha-ab',
      members: [
        { cid: 'bafA', rawSize: 100, sha256: 'shaA' },
        { cid: 'bafB', rawSize: 200, sha256: 'shaB' },
      ],
    })
    db.saveAggregate(0, 'rootAB', 256n, ['packAB'])
    const stats = db.committedSourceCidStats([0])
    assert.equal(stats.total, 2)
    assert.equal(stats.inPieces, 2)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
