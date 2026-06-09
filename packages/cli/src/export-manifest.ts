/**
 * Export the DB's prepared pieces as a v1 run manifest — the CLI counterpart of
 * the browser console's "Download run manifest". Completes the round-trip: a run
 * prepared (or imported) on the CLI can move to the browser to sign, and back.
 *
 * The manifest is prepare-level (see `ipfs2foc-core/manifest`): it carries each
 * done piece's commitment + a pull URL, not live run state (tx hashes, data-set
 * id, aggregate status). It re-imports into a fresh DB and re-derives the same
 * plan; the local `.db` file remains the artifact for same-machine submit resume.
 */

import { buildCarUrl, relayPullUrl } from 'ipfs2foc-core'
import { buildManifest, type ManifestPiece, type RunManifest } from 'ipfs2foc-core/manifest'
import type { MigrationDB } from './db.ts'

export interface ExportManifestOptions {
  network: string
  /**
   * When set, each piece's `sourceUrl` is built as the stateless-relay pull URL;
   * otherwise it is the direct gateway CAR URL. Either is valid — `import` rebuilds
   * the pull URL from the gateway at submit time — so this only sets the manifest's
   * recorded `sourceUrl`/`relayBase` hint.
   */
  relayBase?: string | null
  /** ISO-8601 timestamp to stamp into the manifest. */
  now: string
}

export interface ExportResult {
  manifest: RunManifest
  /** Pieces marked oversized for this run's aggregate budget, excluded from the export. */
  excludedOversized: number
}

/**
 * Build a v1 run manifest from the DB's `done` pieces. Throws if there are none,
 * or if the done pieces span more than one gateway (the v1 manifest is
 * single-gateway, like the browser console's). Oversized pieces are excluded and
 * reported via `excludedOversized` so the caller can warn rather than drop silently.
 */
export function buildExportManifest(db: MigrationDB, opts: ExportManifestOptions): ExportResult {
  const done = db.donePieces().filter((p) => p.pieceCid != null && p.rawSize != null && p.gateway != null)
  if (done.length === 0) {
    throw new Error('no done pieces to export — run `plan` (or `import-manifest`) first, then export')
  }

  const gateways = new Set(done.map((p) => p.gateway as string))
  if (gateways.size > 1) {
    throw new Error(
      `the v1 manifest is single-gateway, but the done pieces span ${gateways.size} gateways ` +
        `(${[...gateways].join(', ')}); a multi-gateway export is not supported`
    )
  }
  const gateway = done[0].gateway as string
  const relayBase = opts.relayBase != null && opts.relayBase !== '' ? opts.relayBase : null
  const gatewayHost = new URL(gateway).hostname

  const pieces: ManifestPiece[] = done.map((p) => {
    const pieceCid = p.pieceCid as string
    const sourceUrl =
      relayBase == null ? buildCarUrl(gateway, p.cid) : relayPullUrl(relayBase, gatewayHost, p.cid, pieceCid)
    return { cid: p.cid, pieceCid, rawSize: p.rawSize as number, sourceUrl }
  })

  const manifest = buildManifest(pieces, {
    tool: 'ipfs2foc',
    network: opts.network,
    relayBase,
    gateway,
    now: opts.now,
  })
  return { manifest, excludedOversized: db.counts().oversized }
}
