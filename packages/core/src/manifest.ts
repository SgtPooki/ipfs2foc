/**
 * The run manifest: the portable, versioned artifact the prepare step produces
 * and the submit step (CLI `pdp-submit` or an in-browser signing flow) consumes.
 * It is the single interchange contract that lets a run move between the browser
 * console (IndexedDB) and the local CLI (`node:sqlite`).
 *
 * SINGLE SOURCE OF TRUTH. Both producers — `app/src/manifest.ts` (browser) and
 * `ipfs2foc export` (CLI) — and the only consumer (`import-manifest.ts`) use the
 * type, builder, and validator defined here. Do not re-declare the shape
 * elsewhere; a second copy would drift and break the round-trip.
 *
 * ## Schema v1 (LOCKED)
 *
 * ```jsonc
 * {
 *   "version": 1,
 *   "tool": "ipfs2foc-app" | "ipfs2foc",  // producer id; metadata, not validated on import
 *   "createdAt": "2026-06-09T18:00:00.000Z", // ISO-8601; metadata
 *   "network": "mainnet" | "calibration",  // import must target the same network
 *   "relayBase": "https://…" | null,        // relay the producer used; hint only
 *   "gateway": "https://trustless-gateway.link", // source the commitments were computed against
 *   "pieces": [
 *     { "cid": "<canonical CIDv1>", "pieceCid": "<PieceCID v2>", "rawSize": 119874, "sourceUrl": "https://…" }
 *   ]
 * }
 * ```
 *
 * v1 is **prepare-level / plan-identical**: it carries the per-piece commitments
 * and pull URLs the submit step needs, NOT live run state (tx hashes, data-set
 * id, per-aggregate status). That keeps it byte-safe to import into a fresh DB
 * and re-derive the same plan. Cross-machine resume of an in-flight submit is a
 * separate, future concern (a `--include-state` export + chain-reconciling
 * import), deliberately out of v1.
 *
 * Pure module — no `node:` imports, no DOM-only globals — so the browser, the
 * CLI, and a Worker can all import it.
 */

import * as Piece from '@web3-storage/data-segment/piece'
import { canonicalCid } from './car-url.ts'

/** The supported manifest schema version. Bump only on a breaking shape change. */
export const MANIFEST_VERSION = 1

/** One prepared piece: a source CID, its commitment, raw size, and a pull URL. */
export interface ManifestPiece {
  cid: string
  pieceCid: string
  rawSize: number
  sourceUrl: string
}

/** The version-1 run manifest. */
export interface RunManifest {
  version: typeof MANIFEST_VERSION
  /** Producer id (e.g. `ipfs2foc-app`, `ipfs2foc`). Metadata; not validated on import. */
  tool: string
  /** ISO-8601 timestamp of when the manifest was produced. Metadata. */
  createdAt: string
  /** Network the commitments target; import must use the same `--network`. */
  network: string
  /** Relay base the producer was configured with; null if none. Hint only. */
  relayBase: string | null
  /** Source gateway the commitments were computed against. */
  gateway: string
  pieces: ManifestPiece[]
}

/** Build a v1 run manifest from prepared pieces. Pure; the same shape both producers emit. */
export function buildManifest(
  pieces: ReadonlyArray<ManifestPiece>,
  opts: { tool: string; network: string; relayBase: string | null; gateway: string; now: string }
): RunManifest {
  return {
    version: MANIFEST_VERSION,
    tool: opts.tool,
    createdAt: opts.now,
    network: opts.network,
    relayBase: opts.relayBase,
    gateway: opts.gateway,
    pieces: pieces.map((p) => ({
      cid: p.cid,
      pieceCid: p.pieceCid,
      rawSize: p.rawSize,
      sourceUrl: p.sourceUrl,
    })),
  }
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
 * the operator can tell a truncated download from an edited file from a manifest
 * produced by a newer tool.
 *
 * Validation is strict on every field the import consumes (`version`, `network`,
 * `gateway`, `pieces`); metadata fields it does not act on (`tool`, `createdAt`)
 * are carried through when present, so a manifest from another tool that emits
 * the same version-1 shape imports cleanly.
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
        `manifest version ${m.version} is newer than this tool understands (${MANIFEST_VERSION}); update ipfs2foc`
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
    tool: typeof m.tool === 'string' ? m.tool : 'unknown',
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : '',
    network: m.network,
    gateway: m.gateway,
    relayBase: typeof m.relayBase === 'string' && m.relayBase !== '' ? m.relayBase : null,
    pieces,
  }
}
