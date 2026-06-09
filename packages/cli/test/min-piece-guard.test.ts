/**
 * Unit coverage for the pre-submit min-piece-size guard.
 *
 * The guard rejects aggregates whose padded sub-piece size falls below the
 * provider's `Min Piece Size`. Padded size derives from the PieceCID v2
 * height (`32 * 2^height`); the test fixture's members were CommP'd from
 * source CARs, so each member's padded size is a stable function of its
 * pieceCid. The two large-file members in the fixture sit at 8 MiB padded
 * (height 18), so any min ≤ 8 MiB passes and a min above that flags them.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as Piece from '@web3-storage/data-segment/piece'
import { Padded } from '@web3-storage/data-segment/piece/size'
import { checkMinPieceSize } from 'ipfs2foc-core/min-piece-guard'

interface Fixture {
  members: Array<{ pieceCid: string; rawSize: number }>
}

const fixture: Fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/multi-asset-aggregate.json', import.meta.url)), 'utf8')
)

const ONE_MIB = 1n << 20n
const ONE_GIB = 1n << 30n

test('passes when every padded sub-piece meets the minimum', () => {
  const r = checkMinPieceSize(fixture.members, 1024n)
  assert.equal(r.ok, true)
  assert.equal(r.tooSmall.length, 0)
})

test('flags every sub-piece when the minimum exceeds the largest padded size', () => {
  const r = checkMinPieceSize(fixture.members, ONE_GIB)
  assert.equal(r.ok, false)
  assert.equal(r.tooSmall.length, fixture.members.length)
  for (const f of r.tooSmall) {
    assert.ok(f.paddedSize < ONE_GIB)
  }
})

test('reports the offending sub-pieces and their padded sizes', () => {
  const r = checkMinPieceSize(fixture.members, ONE_MIB)
  for (const f of r.tooSmall) {
    const expected = Padded.fromHeight(Piece.fromString(f.pieceCid).height)
    assert.equal(f.paddedSize, expected)
    assert.ok(f.paddedSize < ONE_MIB)
  }
  // Sanity: a member whose padded size meets the min is never flagged.
  const flagged = new Set(r.tooSmall.map((s) => s.pieceCid))
  for (const m of fixture.members) {
    if (flagged.has(m.pieceCid)) continue
    const padded = Padded.fromHeight(Piece.fromString(m.pieceCid).height)
    assert.ok(padded >= ONE_MIB)
  }
})

test('empty member list is trivially ok', () => {
  const r = checkMinPieceSize([], ONE_GIB)
  assert.equal(r.ok, true)
  assert.equal(r.tooSmall.length, 0)
})
