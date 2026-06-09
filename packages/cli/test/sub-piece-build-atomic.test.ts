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

test('recordBuiltSubPiece persists sub_pieces + sub_piece_members atomically', async () => {
  const { dir, db } = await dbAt('built-atomic')
  try {
    db.addCids(['bafA', 'bafB'])
    db.recordPieceSuccess('bafA', 'pcA', 100, 'g', 'u', 'shaA')
    db.recordPieceSuccess('bafB', 'pcB', 200, 'g', 'u', 'shaB')
    db.recordBuiltSubPiece({
      subPieceCid: 'subP',
      assembledCarLength: 300,
      targetSizeBytes: 512 * 1024 * 1024,
      carPath: '/tmp/x.car',
      assembledSha256: 'sha-x',
      members: [
        { cid: 'bafA', rawSize: 100, sha256: 'shaA' },
        { cid: 'bafB', rawSize: 200, sha256: 'shaB' },
      ],
    })
    const sp = db.subPieceByCid('subP')!
    assert.equal(sp.status, 'built')
    assert.equal(sp.carPath, '/tmp/x.car')
    assert.equal(sp.assembledSha256, 'sha-x')
    assert.deepEqual(db.subPieceMemberCids('subP'), ['bafA', 'bafB'])
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('recordBuiltSubPiece rejects when any member is missing from pieces (rollback)', async () => {
  const { dir, db } = await dbAt('built-rollback')
  try {
    db.addCids(['bafA'])
    db.recordPieceSuccess('bafA', 'pcA', 100, 'g', 'u', 'shaA')
    // bafC was never added — the FK on sub_piece_members.member_cid → pieces.cid
    // should fail. The whole insert must roll back so no orphan sub_pieces row
    // remains.
    let threw = false
    try {
      db.recordBuiltSubPiece({
        subPieceCid: 'subP',
        assembledCarLength: 200,
        targetSizeBytes: 512 * 1024 * 1024,
        carPath: '/tmp/x.car',
        assembledSha256: 'sha-x',
        members: [
          { cid: 'bafA', rawSize: 100, sha256: 'shaA' },
          { cid: 'bafC', rawSize: 100, sha256: 'shaC' },
        ],
      })
    } catch {
      threw = true
    }
    assert.ok(threw, 'expected the missing-member insert to throw')
    assert.equal(db.subPieceByCid('subP'), null, 'no sub_pieces row should remain after rollback')
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
