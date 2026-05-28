/**
 * Bin-pack pieces into aggregate pieces and compute each aggregate's root
 * PieceCID v2.
 *
 * The data-segment builder bounds how much fits in one aggregate piece (by
 * fr32-padded size); packing fills greedily up to the configured piece size. The
 * aggregate root is the aggregate piece commitment over the members (see
 * piece-aggregate.ts), the value the provider re-derives on add.
 */

import * as Aggregate from '@web3-storage/data-segment/aggregate'
import * as Piece from '@web3-storage/data-segment/piece'
import type { PieceResult } from './piece.ts'
import { pieceAggregateCommP } from './piece-aggregate.ts'

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

/**
 * Greedily pack pieces into aggregate pieces of `aggregateSizeBytes` (fr32-padded
 * piece size, bounded by the provider's max piece size). Order is preserved; a
 * piece that cannot fit an empty aggregate is reported as oversized.
 */
export function packAggregates(pieces: PieceResult[], aggregateSizeBytes: bigint): PackResult {
  const size = Aggregate.Size.from(aggregateSizeBytes)
  const aggregates: AggregatePlan[] = []
  const oversized: PieceResult[] = []

  let builder = Aggregate.createBuilder({ size })
  let members: PieceResult[] = []

  const seal = (): void => {
    if (members.length === 0) {
      return
    }
    // The builder bounds capacity/grouping; the on-chain aggregate root is the
    // aggregate piece commitment over the sub-pieces (what the provider re-derives).
    const root = pieceAggregateCommP(members.map((m) => ({ pieceCid: m.pieceCid, rawSize: m.rawSize }))).rootPieceCid
    aggregates.push({ index: aggregates.length, rootPieceCid: root, members })
    builder = Aggregate.createBuilder({ size })
    members = []
  }

  for (const piece of pieces) {
    const segment = Piece.fromString(piece.pieceCid)

    // Does it fit the current (possibly partially filled) aggregate?
    if (builder.estimate(segment).error == null) {
      builder.write(segment)
      members.push(piece)
      continue
    }

    // Did not fit. Seal the current aggregate and retry in a fresh one.
    seal()
    if (builder.estimate(segment).error == null) {
      builder.write(segment)
      members.push(piece)
    } else {
      // Too big even for an empty aggregate of this size.
      oversized.push(piece)
    }
  }

  seal()
  return { aggregates, oversized }
}
