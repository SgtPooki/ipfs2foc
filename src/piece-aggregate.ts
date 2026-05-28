/**
 * Aggregate piece commitment (what Curio's `/pdp` add-pieces computes via
 * `commputils.PieceAggregateCommP`), in pure JS.
 *
 * The aggregate root is the merkle root of the sub-piece commitments laid out
 * largest-first and padded with zero subtrees to the next power of two. The
 * aggregate's v2 piece CID encodes that root plus `rawSize = sum(sub-piece
 * rawSizes)`, which is what the provider re-derives and checks on add.
 *
 * Node primitives (trunc-254 sha256 combine, zero commitments) match
 * `@web3-storage/data-segment` `proof.computeNode` / `zero-comm`.
 */

import { createHash } from 'node:crypto'
import * as Piece from '@web3-storage/data-segment/piece'
import { Unpadded } from '@web3-storage/data-segment/piece/size'

const NODE_SIZE = 32

/** Trunc-254-padded sha256 of two child nodes (clears the top two bits). */
function computeNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  const h = createHash('sha256')
  h.update(left)
  h.update(right)
  const d = h.digest()
  d[NODE_SIZE - 1] &= 0b0011_1111
  return new Uint8Array(d)
}

const zeroCache: Uint8Array[] = [new Uint8Array(NODE_SIZE)]
function zeroComm(level: number): Uint8Array {
  while (zeroCache.length <= level) {
    const prev = zeroCache[zeroCache.length - 1]
    zeroCache.push(computeNode(prev, prev))
  }
  return zeroCache[level]
}

export interface AggregateSubPiece {
  pieceCid: string
  rawSize: number
}

export interface PieceAggregate {
  /** Aggregate root PieceCID v2. */
  rootPieceCid: string
  /** Sub-piece CIDs ordered largest-padded-first, as the provider requires. */
  orderedSubPieceCids: string[]
  rawSize: number
}

/**
 * Compute the aggregate piece commitment over sub-pieces. Sub-pieces are ordered
 * by non-increasing height (largest padded size first), which both aligns the
 * layout and matches the provider's ordering requirement.
 */
export function pieceAggregateCommP(subPieces: AggregateSubPiece[]): PieceAggregate {
  const entries = subPieces
    .map((sp) => {
      const piece = Piece.fromString(sp.pieceCid)
      return { pieceCid: sp.pieceCid, rawSize: sp.rawSize, height: piece.height, node: piece.root as Uint8Array }
    })
    .sort((a, b) => b.height - a.height)

  // Combine equal-height neighbors left-to-right as pieces are placed.
  const stack: Array<{ h: number; n: Uint8Array }> = []
  for (const e of entries) {
    let cur = { h: e.height, n: e.node }
    while (stack.length > 0 && stack[stack.length - 1].h === cur.h) {
      const left = stack.pop() as { h: number; n: Uint8Array }
      cur = { h: cur.h + 1, n: computeNode(left.n, cur.n) }
    }
    stack.push(cur)
  }

  // Reduce the remaining strictly-decreasing-height stack to one root, zero-padding the tail.
  while (stack.length > 1) {
    let right = stack.pop() as { h: number; n: Uint8Array }
    const left = stack[stack.length - 1]
    while (right.h < left.h) {
      right = { h: right.h + 1, n: computeNode(right.n, zeroComm(right.h)) }
    }
    stack.pop()
    stack.push({ h: left.h + 1, n: computeNode(left.n, right.n) })
  }

  const { n: root } = stack[0]
  const rawSize = subPieces.reduce((sum, sp) => sum + sp.rawSize, 0)

  // The v2 envelope (PieceCID v2: root + height + padding) is built from the
  // aggregate payload size, matching Curio's `commcid.PieceCidV2FromV1(v1,
  // sumRawSizes)` (cmd/pdptool aggregation). The envelope height derives from
  // the payload, which is the minimal tree that holds `rawSize` bytes — at or
  // below the merkle tree's own height, since that height is sized to the sum
  // of the sub-pieces' padded sizes. The provider re-derives and checks only
  // the v1 commitment (`pdp/handlers_add.go`), so the v1 root is the binding
  // value and the envelope carries the payload size for the on-chain record.
  const payload = BigInt(rawSize)
  const padding = Unpadded.toPadding(payload)
  const height = Unpadded.toHeight(payload)
  const rootPieceCid = Piece.toLink({ root, height, padding }).toString()

  return { rootPieceCid, orderedSubPieceCids: entries.map((e) => e.pieceCid), rawSize }
}
