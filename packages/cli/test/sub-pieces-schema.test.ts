/**
 * Sub-piece schema regression: atomic built lifecycle, redirect-server lookup,
 * eviction trigger that runs on `markCommitted`.
 */

import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'

function freshDb(): { db: MigrationDB; path: string } {
  const path = `./.test-pack-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  return { db: new MigrationDB(path), path }
}

test('recordBuiltSubPiece writes sub_piece + members atomically as built', () => {
  const { db, path } = freshDb()
  try {
    db.addCids(['bafkreih000', 'bafkreih001'])
    db.recordPieceSuccess('bafkreih000', 'pc-000', 256, 'g', 'u', 'aa')
    db.recordPieceSuccess('bafkreih001', 'pc-001', 256, 'g', 'u', 'bb')
    db.recordBuiltSubPiece({
      subPieceCid: 'bafkzcibBUILT',
      assembledCarLength: 1024,
      targetSizeBytes: 512 * 1024 * 1024,
      carPath: '/tmp/foo.car',
      assembledSha256: 'deadbeef',
      members: [
        { cid: 'bafkreih000', rawSize: 256, sha256: 'aa' },
        { cid: 'bafkreih001', rawSize: 256, sha256: 'bb' },
      ],
    })

    const built = db.subPieceByCid('bafkzcibBUILT')
    assert.ok(built != null)
    assert.equal(built.status, 'built')
    assert.equal(built.carPath, '/tmp/foo.car')
    assert.equal(built.url, null)
    assert.equal(built.assembledSha256, 'deadbeef')

    assert.deepEqual(db.subPieceMemberCids('bafkzcibBUILT'), ['bafkreih000', 'bafkreih001'])
    assert.equal(db.lockedSubPieceMemberCids().size, 2)
  } finally {
    db.close()
    rmSync(path, { force: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
  }
})

test('recordPassthroughSubPiece writes the single source CID as a 1-member sub-piece with url set', () => {
  const { db, path } = freshDb()
  try {
    db.addCids(['bafkreih200'])
    db.recordPieceSuccess('bafkreih200', 'pc-200', 500, 'g', 'https://gateway/ipfs/bafkreih200?format=car', 'sha-200')
    db.recordPassthroughSubPiece({
      subPieceCid: 'pc-200',
      sourceCid: 'bafkreih200',
      url: 'https://gateway/ipfs/bafkreih200?format=car',
      rawSize: 500,
      memberSha256: 'sha-200',
    })

    const sp = db.subPieceByCid('pc-200')
    assert.ok(sp != null)
    assert.equal(sp.status, 'built')
    assert.equal(sp.carPath, null)
    assert.equal(sp.url, 'https://gateway/ipfs/bafkreih200?format=car')
    assert.deepEqual(db.subPieceMemberCids('pc-200'), ['bafkreih200'])
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
    db.recordPieceSuccess('bafkreih100', 'pc-100', 100, 'g', 'u', null)
    db.recordBuiltSubPiece({
      subPieceCid: 'bafkzcibSUB1',
      assembledCarLength: 100,
      targetSizeBytes: 1024,
      carPath: '/tmp/sub1.car',
      assembledSha256: 'aabbcc',
      members: [{ cid: 'bafkreih100', rawSize: 100, sha256: null }],
    })
    db.saveAggregate(0, 'bafkzcibROOT', 1024n, ['bafkzcibSUB1'])
    const evict = db.carPathsForAggregateOnCommit(0)
    assert.deepEqual(evict, ['/tmp/sub1.car'])
  } finally {
    db.close()
    rmSync(path, { force: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
  }
})

test('passthrough sub-piece does not register a car_path so carPathsForAggregateOnCommit ignores it', () => {
  const { db, path } = freshDb()
  try {
    db.addCids(['bafkreih300'])
    db.recordPieceSuccess('bafkreih300', 'pc-300', 100, 'g', 'https://g/x', null)
    db.recordPassthroughSubPiece({
      subPieceCid: 'pc-300',
      sourceCid: 'bafkreih300',
      url: 'https://g/x',
      rawSize: 100,
      memberSha256: null,
    })
    db.saveAggregate(0, 'pc-300', 1024n, ['pc-300'])
    const evict = db.carPathsForAggregateOnCommit(0)
    assert.deepEqual(evict, [], 'passthrough sub-pieces have no local CAR to evict')
  } finally {
    db.close()
    rmSync(path, { force: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
  }
})
