/**
 * Sub-piece schema regression: planned -> built lifecycle, the redirect-server
 * lookup, and the eviction trigger that runs on `markCommitted`.
 */

import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'

function freshDb(): { db: MigrationDB; path: string } {
  const path = `./.test-pack-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  return { db: new MigrationDB(path), path }
}

test('sub_piece planned row becomes built and is found by the redirect lookup', () => {
  const { db, path } = freshDb()
  try {
    db.addCids(['bafkreih000', 'bafkreih001'])
    db.recordPlannedSubPiece({
      subPieceCid: 'bafkzcibPLAN_PLACEHOLDER',
      assembledCarLength: 1024,
      targetSizeBytes: 512 * 1024 * 1024,
      members: [
        { cid: 'bafkreih000', rawSize: 256, sha256: 'aa' },
        { cid: 'bafkreih001', rawSize: 256, sha256: 'bb' },
      ],
    })

    const planned = db.subPieceByCid('bafkzcibPLAN_PLACEHOLDER')
    assert.ok(planned != null)
    assert.equal(planned.status, 'planned')
    assert.equal(planned.assembledCarLength, 1024)

    db.markSubPieceBuilt('bafkzcibPLAN_PLACEHOLDER', '/tmp/foo.car', 'deadbeef')
    const built = db.subPieceByCid('bafkzcibPLAN_PLACEHOLDER')
    assert.ok(built != null)
    assert.equal(built.status, 'built')
    assert.equal(built.carPath, '/tmp/foo.car')
    assert.equal(built.assembledSha256, 'deadbeef')

    // Members are returned in their canonical sort order (insertion order in
    // this case, which the planner maintains).
    const members = db.subPieceMemberCids('bafkzcibPLAN_PLACEHOLDER')
    assert.deepEqual(members, ['bafkreih000', 'bafkreih001'])

    // Locked set protects sub-piece members from being re-packed by a fresh
    // call to `donePiecesFreeForPacking`.
    const locked = db.lockedSubPieceMemberCids()
    assert.equal(locked.size, 2)
    assert.ok(locked.has('bafkreih000'))
  } finally {
    db.close()
    rmSync(path, { force: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
  }
})

test('carPathsForAggregateOnCommit returns the built sub-piece file for eviction', () => {
  const { db, path } = freshDb()
  try {
    db.addCids(['bafkreih100'])
    db.recordPlannedSubPiece({
      subPieceCid: 'bafkzcibSUB1',
      assembledCarLength: 100,
      targetSizeBytes: 1024,
      members: [{ cid: 'bafkreih100', rawSize: 100, sha256: null }],
    })
    db.markSubPieceBuilt('bafkzcibSUB1', '/tmp/sub1.car', 'aabbcc')
    db.saveAggregate(0, 'bafkzcibROOT', 1024n, [{ subPieceCid: 'bafkzcibSUB1' }])
    const evict = db.carPathsForAggregateOnCommit(0)
    assert.deepEqual(evict, ['/tmp/sub1.car'])
  } finally {
    db.close()
    rmSync(path, { force: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
  }
})
