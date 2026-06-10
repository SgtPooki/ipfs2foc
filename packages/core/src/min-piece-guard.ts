/**
 * Provider min-piece-size guard. Pure logic, no I/O.
 *
 * Curio's `Min Piece Size` (`PDPOffering.minPieceSizeInBytes` on the SP
 * registry product entry) is a padded piece-size floor; any sub-piece below
 * it gets rejected on pull. The padded size for a sub-piece is derived from
 * its PieceCID v2 height: `padded = 32 * 2^height` bytes.
 *
 * `checkMinPieceSize` returns the set of sub-piece CIDs whose padded size is
 * below the provider's minimum. An empty `tooSmall` array means the
 * aggregate is safe to submit.
 */

import * as Piece from '@web3-storage/data-segment/piece'
// Naming trap: data-segment's `Padded` is the fr32 payload size (127/128 of
// the power of two — what Filecoin calls UNPADDED), while `Expanded` is the
// power-of-two piece size Curio's floor is expressed in. Using Padded here
// under-reports every piece by 128/127 and wrongly rejects pieces that sit
// exactly at the provider minimum.
import { Expanded } from '@web3-storage/data-segment/piece/size'

export interface MinPieceCheckMember {
  pieceCid: string
}

export interface MinPieceCheckResult {
  ok: boolean
  tooSmall: Array<{ pieceCid: string; paddedSize: bigint }>
  minPieceSize: bigint
}

/**
 * Check every aggregate member's padded piece size against the provider's
 * minimum. Returns the offending sub-piece CIDs so the caller can log a
 * single operator-facing line that names them.
 */
export function checkMinPieceSize(members: MinPieceCheckMember[], minPieceSize: bigint): MinPieceCheckResult {
  const tooSmall: Array<{ pieceCid: string; paddedSize: bigint }> = []
  for (const m of members) {
    const piece = Piece.fromString(m.pieceCid)
    const paddedSize = Expanded.fromHeight(piece.height)
    if (paddedSize < minPieceSize) {
      tooSmall.push({ pieceCid: m.pieceCid, paddedSize })
    }
  }
  return { ok: tooSmall.length === 0, tooSmall, minPieceSize }
}
