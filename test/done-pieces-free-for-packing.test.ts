import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MigrationDB } from '../src/db.ts'

async function dbAt(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `foc-${name}-`))
  return { dir, db: new MigrationDB(join(dir, 'migrate.db')) }
}

test('donePiecesFreeForPacking excludes cids locked in submitted aggregates', async () => {
  const { dir, db } = await dbAt('free-pack-submitted')
  try {
    db.addCids(['bafA', 'bafB', 'bafC'])
    db.recordPieceSuccess('bafA', 'pcA', 100, 'g', 'u', 'shaA')
    db.recordPieceSuccess('bafB', 'pcB', 200, 'g', 'u', 'shaB')
    db.recordPieceSuccess('bafC', 'pcC', 300, 'g', 'u', 'shaC')
    db.saveAggregate(0, 'root-0', 256n, [{ cid: 'bafA' }, { cid: 'bafB' }])
    db.markSubmitted(0, 'pull-0')
    const free = db.donePiecesFreeForPacking().map((p) => p.cid).sort()
    assert.deepEqual(free, ['bafC'], 'bafA and bafB are locked in a submitted aggregate')
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('donePiecesFreeForPacking includes cids in still-planned aggregates (re-pack allowed)', async () => {
  const { dir, db } = await dbAt('free-pack-planned')
  try {
    db.addCids(['bafA', 'bafB'])
    db.recordPieceSuccess('bafA', 'pcA', 100, 'g', 'u', 'shaA')
    db.recordPieceSuccess('bafB', 'pcB', 200, 'g', 'u', 'shaB')
    db.saveAggregate(0, 'root-0', 256n, [{ cid: 'bafA' }, { cid: 'bafB' }])
    // Status stays 'planned' — operator may still re-pack.
    const free = db.donePiecesFreeForPacking().map((p) => p.cid).sort()
    assert.deepEqual(free, ['bafA', 'bafB'])
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('donePiecesFreeForPacking excludes cids already locked into a sub_piece', async () => {
  const { dir, db } = await dbAt('free-pack-subpiece')
  try {
    db.addCids(['bafA', 'bafB'])
    db.recordPieceSuccess('bafA', 'pcA', 100, 'g', 'u', 'shaA')
    db.recordPieceSuccess('bafB', 'pcB', 200, 'g', 'u', 'shaB')
    db.recordBuiltSubPiece({
      subPieceCid: 'sub-AB',
      assembledCarLength: 300,
      targetSizeBytes: 512 * 1024 * 1024,
      carPath: '/tmp/x.car',
      assembledSha256: 'sha-x',
      members: [
        { cid: 'bafA', rawSize: 100, sha256: 'shaA' },
        { cid: 'bafB', rawSize: 200, sha256: 'shaB' },
      ],
    })
    const free = db.donePiecesFreeForPacking().map((p) => p.cid)
    assert.deepEqual(free, [], 'both members are already in a sub-piece')
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
