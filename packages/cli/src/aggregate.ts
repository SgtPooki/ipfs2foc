/**
 * Bin-pack pieces into aggregate pieces and compute each aggregate's root
 * PieceCID v2.
 *
 * An aggregate's on-chain padded size is the next power of two of the sum of its
 * sub-pieces' padded sizes, so packing fills greedily while that running sum
 * stays within `aggregateSizeBytes`. The aggregate root is the aggregate piece
 * commitment over the members (see `ipfs2foc-core/piece-aggregate`), the value the provider
 * re-derives on add.
 */

import * as Piece from '@web3-storage/data-segment/piece'
import { pieceAggregateCommP } from 'ipfs2foc-core/piece-aggregate'
import type { PieceResult } from './piece.ts'

const NODE_SIZE = 32n

export interface AggregatePlan {
  index: number
  /** Aggregate root PieceCID v2 (aggregate piece commitment). */
  rootPieceCid: string
  members: PieceResult[]
}

export interface PackResult {
  aggregates: AggregatePlan[]
  /** Pieces too large to fit any aggregate of the configured piece size. */
  oversized: PieceResult[]
}

/** A piece's fr32-padded size in bytes, from its PieceCID v2 tree height. */
function paddedSize(pieceCid: string): bigint {
  return 2n ** BigInt(Piece.fromString(pieceCid).height) * NODE_SIZE
}

/**
 * Greedily pack pieces into aggregate pieces whose summed padded size stays
 * within `aggregateSizeBytes` (bounded by the provider's max piece size). Order
 * is preserved; a piece whose own padded size exceeds the budget is reported as
 * oversized.
 */
export function packAggregates(pieces: PieceResult[], aggregateSizeBytes: bigint): PackResult {
  const aggregates: AggregatePlan[] = []
  const oversized: PieceResult[] = []

  let members: PieceResult[] = []
  let used = 0n

  const flush = (): void => {
    if (members.length === 0) {
      return
    }
    const root = pieceAggregateCommP(members.map((m) => ({ pieceCid: m.pieceCid, rawSize: m.rawSize }))).rootPieceCid
    aggregates.push({ index: aggregates.length, rootPieceCid: root, members })
    members = []
    used = 0n
  }

  for (const piece of pieces) {
    const size = paddedSize(piece.pieceCid)
    if (size > aggregateSizeBytes) {
      oversized.push(piece)
      continue
    }
    if (used + size > aggregateSizeBytes) {
      flush()
    }
    members.push(piece)
    used += size
  }

  flush()
  return { aggregates, oversized }
}
