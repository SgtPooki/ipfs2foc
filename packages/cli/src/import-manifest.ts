/**
 * Import a browser-console run manifest into the migration DB.
 *
 * The console's prepare step computes each CID's piece commitment over the
 * same canonical block-verified CAR the CLI builds (the two hashers are
 * pinned byte-identical in `test/commp-wasm-parity.test.ts`) and saves the
 * run as a JSON manifest. `import-manifest` records those commitments as
 * done pieces without recomputing anything, then wraps and packs them the
 * same way `plan` does, so `pdp-submit` drives them unchanged.
 *
 * Trust stance: manifest PieceCIDs are recorded as-is. The storage provider
 * recomputes every commitment from the bytes it pulls and the on-chain
 * AddPieces only lands on a match, so a wrong manifest value fails loudly at
 * submission — it can never silently commit wrong bytes. What import has to
 * guarantee is shape (canonical CIDs, real PieceCID v2 values, sane sizes)
 * and hygiene (network match, never overwriting prior local state).
 */

import { buildCarUrl } from 'ipfs2foc-core'
import type { ManifestPiece, RunManifest } from 'ipfs2foc-core/manifest'
import type { MigrationDB } from './db.ts'
import { appendAggregatesFromFreeSubPieces, wrapDonePiecesAsPassthroughSubPieces } from './migrate.ts'

// The manifest type, builder, and validator are the single source of truth in
// `ipfs2foc-core/manifest` (shared with the browser console). Re-export them so
// existing CLI importers keep their import path.
export {
  buildManifest,
  MANIFEST_VERSION,
  type ManifestPiece,
  parseRunManifest,
  type RunManifest,
} from 'ipfs2foc-core/manifest'

export interface ImportManifestOptions {
  network: 'mainnet' | 'calibration'
  /** Aggregate raw-size budget, the same `--piece-size` knob `plan` takes. */
  aggregateSizeBytes: bigint
  /** Default true. When false, stop after recording pieces (pack later with `pack-cars`). */
  autoPack?: boolean
}

export interface ImportSummary {
  network: string
  total: number
  imported: number
  alreadyRecorded: number
  aggregateCount: number
  oversized: string[]
}

/**
 * Record the manifest's pieces as done, wrap them as passthrough sub-pieces,
 * and append aggregates — the same state `plan` leaves behind.
 *
 * The stored `url` is the canonical gateway CAR URL rebuilt from the
 * manifest's gateway and each piece's CID — the exact bytes the commitment
 * was computed over. The manifest's `sourceUrl` routes through whichever
 * relay the console was configured with; submission picks its own
 * `--source-relay` and rebuilds the pull URL from the gateway URL, so the
 * gateway URL is what gets persisted.
 *
 * Conflicts are checked before anything is written: a refused import leaves
 * the DB untouched, and re-importing the same manifest is a no-op for pieces
 * already recorded.
 */
export function runImportManifest(db: MigrationDB, manifest: RunManifest, opts: ImportManifestOptions): ImportSummary {
  if (manifest.network !== opts.network) {
    throw new Error(
      `manifest was prepared on ${manifest.network} but this import targets --network ${opts.network}; ` +
        `re-run with --network ${manifest.network}, or prepare a manifest for ${opts.network}`
    )
  }

  const toImport: ManifestPiece[] = []
  let alreadyRecorded = 0
  const conflicts: string[] = []
  for (const piece of manifest.pieces) {
    const existing = db.pieceByCid(piece.cid)
    if (existing == null) {
      if (db.subPieceByCid(piece.pieceCid) != null) {
        conflicts.push(`${piece.cid}: PieceCID ${piece.pieceCid} is already recorded as a sub-piece of another source`)
        continue
      }
      toImport.push(piece)
      continue
    }
    if (existing.status === 'done' || existing.status === 'oversized') {
      if (existing.pieceCid === piece.pieceCid && existing.rawSize === piece.rawSize) {
        alreadyRecorded += 1
      } else {
        conflicts.push(
          `${piece.cid}: recorded as ${existing.pieceCid} (${existing.rawSize} bytes), ` +
            `manifest says ${piece.pieceCid} (${piece.rawSize} bytes)`
        )
      }
      continue
    }
    // pending / processing / failed: the local run has no commitment for this
    // CID yet; the manifest supplies it, so the row upgrades to done.
    toImport.push(piece)
  }
  if (conflicts.length > 0) {
    const shown = conflicts.slice(0, 5).join('\n  ')
    const more = conflicts.length > 5 ? `\n  … and ${conflicts.length - 5} more` : ''
    throw new Error(
      `refusing to import: ${conflicts.length} piece(s) conflict with existing DB state — nothing was written.\n` +
        `  ${shown}${more}\n` +
        `A recorded piece is never overwritten; import into a fresh --db if the manifest is the intended record.`
    )
  }

  db.addCids(toImport.map((p) => p.cid))
  for (const piece of toImport) {
    db.recordPieceSuccess(
      piece.cid,
      piece.pieceCid,
      piece.rawSize,
      manifest.gateway,
      buildCarUrl(manifest.gateway, piece.cid),
      null
    )
  }

  let oversized: string[] = []
  if (opts.autoPack !== false) {
    wrapDonePiecesAsPassthroughSubPieces(db)
    oversized = appendAggregatesFromFreeSubPieces(db, opts.aggregateSizeBytes)
  }

  return {
    network: opts.network,
    total: manifest.pieces.length,
    imported: toImport.length,
    alreadyRecorded,
    aggregateCount: db.aggregates().length,
    oversized,
  }
}
