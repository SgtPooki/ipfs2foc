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

test('donePiecesFreeForPacking excludes cids wrapped as passthrough sub-pieces', async () => {
  const { dir, db } = await dbAt('free-pack-passthrough')
  try {
    db.addCids(['bafA', 'bafB', 'bafC'])
    db.recordPieceSuccess('bafA', 'pcA', 100, 'g', 'u', null)
    db.recordPieceSuccess('bafB', 'pcB', 200, 'g', 'u', null)
    db.recordPieceSuccess('bafC', 'pcC', 300, 'g', 'u', null)
    db.recordPassthroughSubPiece({ subPieceCid: 'pcA', sourceCid: 'bafA', url: 'u', rawSize: 100, memberSha256: null })
    db.recordPassthroughSubPiece({ subPieceCid: 'pcB', sourceCid: 'bafB', url: 'u', rawSize: 200, memberSha256: null })
    const free = db
      .donePiecesFreeForPacking()
      .map((p) => p.cid)
      .sort()
    assert.deepEqual(free, ['bafC'], 'bafA and bafB are already members of a sub-piece')
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('donePiecesFreeForPacking returns every done piece when no sub-pieces exist yet', async () => {
  const { dir, db } = await dbAt('free-pack-bare')
  try {
    db.addCids(['bafA', 'bafB'])
    db.recordPieceSuccess('bafA', 'pcA', 100, 'g', 'u', null)
    db.recordPieceSuccess('bafB', 'pcB', 200, 'g', 'u', null)
    const free = db
      .donePiecesFreeForPacking()
      .map((p) => p.cid)
      .sort()
    assert.deepEqual(free, ['bafA', 'bafB'])
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('donePiecesFreeForPacking excludes cids already locked into an assembled sub-piece', async () => {
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
