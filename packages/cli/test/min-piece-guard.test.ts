/**
 * Unit coverage for the pre-submit min-piece-size guard.
 *
 * The guard rejects aggregates whose padded sub-piece size falls below the
 * provider's `Min Piece Size`. Padded size derives from the PieceCID v2
 * height (`32 * 2^height` — data-segment's `Expanded`, NOT its `Padded`,
 * which is the 127/128 fr32 payload size); the test fixture's members were
 * CommP'd from source CARs, so each member's padded size is a stable
 * function of its pieceCid. The two large-file members in the fixture sit at
 * 8 MiB padded (height 18), so any min ≤ 8 MiB passes and a min above that
 * flags them.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as Piece from '@web3-storage/data-segment/piece'
import { Expanded } from '@web3-storage/data-segment/piece/size'
import { checkMinPieceSize } from 'ipfs2foc-core/min-piece-guard'

interface Fixture {
  members: Array<{ pieceCid: string; rawSize: number }>
}

const fixture: Fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/multi-asset-aggregate.json', import.meta.url)), 'utf8')
)

const ONE_MIB = 1n << 20n
const ONE_GIB = 1n << 30n

// A real height-15 piece (962 KiB raw CAR → exactly 1 MiB padded). Pieces
// sitting exactly at the provider minimum must pass — comparing the fr32
// payload size (1,040,384) against a padded floor wrongly rejected these.
const HEIGHT_15_PIECE = 'bafkzcibe6kvagd65hbvcrk42qftybuyt66mb4hcyiqlnhfdtu3mdyr76m7zzvjtgba'

test('passes when every padded sub-piece meets the minimum', () => {
  const r = checkMinPieceSize(fixture.members, 1024n)
  assert.equal(r.ok, true)
  assert.equal(r.tooSmall.length, 0)
})

test('a piece exactly at the minimum passes (padded vs padded, not fr32 payload)', () => {
  assert.equal(Piece.fromString(HEIGHT_15_PIECE).height, 15)
  const r = checkMinPieceSize([{ pieceCid: HEIGHT_15_PIECE }], ONE_MIB)
  assert.equal(r.ok, true)
  const above = checkMinPieceSize([{ pieceCid: HEIGHT_15_PIECE }], ONE_MIB + 1n)
  assert.equal(above.ok, false)
  assert.equal(above.tooSmall[0]?.paddedSize, ONE_MIB)
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
    const expected = Expanded.fromHeight(Piece.fromString(f.pieceCid).height)
    assert.equal(f.paddedSize, expected)
    assert.ok(f.paddedSize < ONE_MIB)
  }
  // Sanity: a member whose padded size meets the min is never flagged.
  const flagged = new Set(r.tooSmall.map((s) => s.pieceCid))
  for (const m of fixture.members) {
    if (flagged.has(m.pieceCid)) continue
    const padded = Expanded.fromHeight(Piece.fromString(m.pieceCid).height)
    assert.ok(padded >= ONE_MIB)
  }
})

test('empty member list is trivially ok', () => {
  const r = checkMinPieceSize([], ONE_GIB)
  assert.equal(r.ok, true)
  assert.equal(r.tooSmall.length, 0)
})
