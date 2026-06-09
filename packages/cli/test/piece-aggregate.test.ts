/**
 * Regression coverage for the aggregate piece commitment.
 *
 * The golden vector is 48 sub-pieces packed into one aggregate. Its expected
 * root was verified against Curio's own path: `commputils.PieceAggregateCommP`
 * over the same sub-pieces (largest padded size first, StackedDrg64GiBV1_1)
 * plus `commcid.PieceCidV2FromV1(v1, sumRawSizes)`. The test guards the JS
 * reduce and the v2 envelope against the value a provider re-derives on add.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as Piece from '@web3-storage/data-segment/piece'
import { pieceAggregateCommP } from 'ipfs2foc-core/piece-aggregate'

interface Fixture {
  members: Array<{ pieceCid: string; rawSize: number }>
  expectedRoot: string
  expectedRawSize: number
}

const fixture: Fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/multi-asset-aggregate.json', import.meta.url)), 'utf8')
)

test('48-sub-piece aggregate matches the provider-verified root', () => {
  const agg = pieceAggregateCommP(fixture.members)
  assert.equal(agg.rootPieceCid, fixture.expectedRoot)
  assert.equal(agg.rawSize, fixture.expectedRawSize)
})

test('root and ordering are self-consistent across input orders', () => {
  // Equal-height sub-pieces combine in the order they are laid out, so the root
  // tracks `orderedSubPieceCids` rather than the raw input order. Submission
  // sends that ordering and presigns the root computed from it, so re-running
  // over the produced ordering reproduces the same root regardless of how the
  // members were first listed.
  const agg = pieceAggregateCommP([...fixture.members].reverse())
  const replayed = pieceAggregateCommP(
    agg.orderedSubPieceCids.map((cid) => fixture.members.find((m) => m.pieceCid === cid)!)
  )
  assert.equal(replayed.rootPieceCid, agg.rootPieceCid)
  assert.deepEqual(replayed.orderedSubPieceCids, agg.orderedSubPieceCids)
})

test('sub-pieces are ordered largest padded size first', () => {
  const agg = pieceAggregateCommP(fixture.members)
  const heights = agg.orderedSubPieceCids.map((cid) => Piece.fromString(cid).height)
  for (let i = 1; i < heights.length; i += 1) {
    assert.ok(heights[i - 1] >= heights[i], `height drops monotonically at index ${i}`)
  }
})

test('aggregate v2 envelope decodes (padding under half the padded size)', () => {
  const agg = pieceAggregateCommP(fixture.members)
  const piece = Piece.fromString(agg.rootPieceCid)
  const paddedSize = 2n ** BigInt(piece.height) * 32n
  assert.ok(piece.padding < paddedSize / 2n, 'padding must be below half the padded size')
})

test('single-sub-piece aggregate is the sub-piece itself', () => {
  const one = fixture.members[0]
  const agg = pieceAggregateCommP([one])
  assert.equal(agg.rootPieceCid, one.pieceCid)
  assert.equal(agg.rawSize, one.rawSize)
})
