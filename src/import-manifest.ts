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

import * as Piece from '@web3-storage/data-segment/piece'
import { buildCarUrl, canonicalCid } from 'ipfs2foc-core'
import type { MigrationDB } from './db.ts'
import { appendAggregatesFromFreeSubPieces, wrapDonePiecesAsPassthroughSubPieces } from './migrate.ts'

/** The supported manifest schema version (`app/src/manifest.ts`). */
export const MANIFEST_VERSION = 1

export interface ManifestPiece {
  cid: string
  pieceCid: string
  rawSize: number
  sourceUrl: string
}

/** The fields of a version-1 run manifest the import consumes. */
export interface RunManifest {
  version: typeof MANIFEST_VERSION
  network: string
  gateway: string
  /** Relay base the console was configured with; used only for the next-step hint. */
  relayBase: string | null
  pieces: ManifestPiece[]
}

function isPieceCidV2(value: string): boolean {
  try {
    Piece.fromString(value)
    return true
  } catch {
    return false
  }
}

/**
 * Parse and validate a run manifest. Throws with the offending field named so
 * the operator can tell a truncated download from an edited file from a
 * manifest produced by a newer console.
 *
 * Validation is strict on every field the import consumes (`version`,
 * `network`, `gateway`, `pieces`); metadata fields it does not act on
 * (`tool`, `createdAt`) are not gated, so a manifest from another tool that
 * emits the same version-1 shape imports cleanly.
 */
export function parseRunManifest(text: string): RunManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`manifest is not valid JSON: ${message}`)
  }
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) {
    throw new Error('manifest must be a JSON object (the file the console saves via "Download run manifest")')
  }
  const m = raw as Record<string, unknown>

  if (m.version !== MANIFEST_VERSION) {
    if (typeof m.version === 'number' && m.version > MANIFEST_VERSION) {
      throw new Error(
        `manifest version ${m.version} is newer than this CLI understands (${MANIFEST_VERSION}); update ipfs2foc`
      )
    }
    throw new Error(`not a run manifest: expected "version": ${MANIFEST_VERSION}, found ${JSON.stringify(m.version)}`)
  }
  if (typeof m.network !== 'string' || m.network === '') {
    throw new Error('manifest is missing "network" (expected mainnet or calibration)')
  }
  if (typeof m.gateway !== 'string' || m.gateway === '') {
    throw new Error('manifest is missing "gateway" (the source gateway the commitments were computed against)')
  }
  let gatewayUrl: URL
  try {
    gatewayUrl = new URL(m.gateway)
  } catch {
    throw new Error(`manifest "gateway" is not a URL: ${JSON.stringify(m.gateway)}`)
  }
  if (gatewayUrl.protocol !== 'https:' && gatewayUrl.protocol !== 'http:') {
    throw new Error(`manifest "gateway" must be an http(s) URL, found ${m.gateway}`)
  }
  if (!Array.isArray(m.pieces) || m.pieces.length === 0) {
    throw new Error('manifest has no pieces — nothing to import')
  }

  const pieces: ManifestPiece[] = []
  const indexByCid = new Map<string, number>()
  const indexByPieceCid = new Map<string, number>()
  m.pieces.forEach((entry, i) => {
    const where = `pieces[${i}]`
    if (typeof entry !== 'object' || entry == null) {
      throw new Error(`${where}: not an object`)
    }
    const p = entry as Record<string, unknown>
    if (typeof p.cid !== 'string' || canonicalCid(p.cid) == null) {
      throw new Error(
        `${where}: "cid" ${JSON.stringify(p.cid)} is not a canonical CIDv1 — the commitment and the pull ` +
          `URL are bound to the exact CID string the console committed over, so a re-encoded form cannot be imported`
      )
    }
    if (typeof p.pieceCid !== 'string' || !isPieceCidV2(p.pieceCid)) {
      throw new Error(`${where} (${p.cid}): "pieceCid" ${JSON.stringify(p.pieceCid)} is not a PieceCID v2`)
    }
    if (typeof p.rawSize !== 'number' || !Number.isSafeInteger(p.rawSize) || p.rawSize <= 0) {
      throw new Error(
        `${where} (${p.cid}): "rawSize" must be a positive integer byte count, found ${JSON.stringify(p.rawSize)}`
      )
    }
    if (typeof p.sourceUrl !== 'string' || p.sourceUrl === '') {
      throw new Error(`${where} (${p.cid}): "sourceUrl" is missing`)
    }
    const dupCid = indexByCid.get(p.cid)
    if (dupCid != null) {
      throw new Error(`${where}: duplicate cid ${p.cid} (already at pieces[${dupCid}])`)
    }
    const dupPiece = indexByPieceCid.get(p.pieceCid)
    if (dupPiece != null) {
      throw new Error(
        `${where} (${p.cid}): PieceCID ${p.pieceCid} already used by pieces[${dupPiece}] — two source CIDs ` +
          `cannot share one piece commitment`
      )
    }
    indexByCid.set(p.cid, i)
    indexByPieceCid.set(p.pieceCid, i)
    pieces.push({ cid: p.cid, pieceCid: p.pieceCid, rawSize: p.rawSize, sourceUrl: p.sourceUrl })
  })

  return {
    version: MANIFEST_VERSION,
    network: m.network,
    gateway: m.gateway,
    relayBase: typeof m.relayBase === 'string' && m.relayBase !== '' ? m.relayBase : null,
    pieces,
  }
}

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
