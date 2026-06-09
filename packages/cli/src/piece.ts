/**
 * Compute a Filecoin piece commitment (PieceCID v2, FRC-0069) over a CAR
 * stream, while verifying the CAR is rooted at the expected CID.
 *
 * The CAR bytes come from the block-verified canonical path
 * (`gateway-blocks.ts`): the DAG is pulled over one streaming CAR request,
 * every block hash-checked, and the canonical CAR serialized locally — never a
 * raw gateway response, which can end early at a block boundary and still
 * parse cleanly.
 *
 * The hash is computed in a single streaming pass — the CAR bytes are never
 * fully buffered — so this scales to large pieces with bounded memory. This is
 * the one unavoidable full read of each object's bytes; everything downstream
 * (aggregate root, submission manifest) is metadata derived from the result.
 */

import { createHash } from 'node:crypto'
import { CarBlockIterator } from '@ipld/car'
import * as Hasher from '@web3-storage/data-segment/multihash'
import { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import * as Link from 'multiformats/link'
import type { FailureCategory, MigrationDB } from './db.ts'
import { GatewayError } from './gateway.ts'
import { fetchCanonicalCar } from './gateway-blocks.ts'
import { DEFAULT_FALLBACK_TIMEOUT_MS, fetchCarViaHelia } from './helia-fallback.ts'

/**
 * Error subclass used internally by piece-compute callers to surface a failure
 * category alongside the message, mirroring `GatewayError` for CAR-level
 * failures (root mismatch, etc.).
 */
export class PieceComputeError extends Error {
  category: FailureCategory
  constructor(message: string, category: FailureCategory) {
    super(message)
    this.name = 'PieceComputeError'
    this.category = category
  }
}

/** Read a category off a thrown error, falling back to `other`. */
export function categoryOf(err: unknown): FailureCategory {
  if (err instanceof GatewayError) return err.category
  if (err instanceof PieceComputeError) return err.category
  return 'other'
}

import { log } from './util.ts'

export interface PieceResult {
  /** The original IPFS CID (the CAR root). Preserved end-to-end. */
  cid: string
  /** PieceCID v2 — the value submitted to the provider and verified against the pulled bytes. */
  pieceCid: string
  /** CAR byte length (the piece payload size the SP will fetch). */
  rawSize: number
  /** Source used: the gateway URL or the literal string `helia` when the fallback served. */
  gateway: string
  /** URL the piece commitment was computed from. Empty when the Helia fallback served. */
  url: string
  /**
   * sha256 of the exact CAR bytes that produced this PieceCID. Captured at
   * first successful fetch and treated as the canonical bytes signature for
   * the CID. CAR bytes can drift between sources (block order, dup handling)
   * and PieceCID was computed against the original; mismatch means re-commP.
   *
   * Optional on the type because repacked rows reconstructed from DB columns
   * predate sha256 capture; on every fresh fetch this is populated.
   */
  memberSha256?: string
  /** Which path served this fetch. Optional for the same reason as `memberSha256`. */
  source?: 'gateway' | 'helia'
}

/** Categories that justify the Helia fallback when it is enabled. */
function shouldFallback(category: FailureCategory): boolean {
  return (
    category === 'source_gateway_5xx' ||
    category === 'source_gateway_429' ||
    category === 'source_gateway_timeout' ||
    category === 'source_gateway_network' ||
    category === 'car_root_mismatch'
  )
}

/**
 * Stream a CAR through the piece hasher, a sha256 tap, and the CAR parser at
 * once. Returns the PieceCID v2, the raw CAR byte length, the sha256 of those
 * same bytes, and the CAR's declared roots.
 */
async function computePiece(
  body: ReadableStream<Uint8Array>
): Promise<{ pieceCid: string; rawSize: number; sha256: string; roots: CID[] }> {
  const hasher = Hasher.create()
  const sha = createHash('sha256')
  let rawSize = 0

  // Tap every chunk on the way to the CAR parser: feed the piece hasher, the
  // sha256 digest, and the byte counter. Draining the block iterator pulls the
  // whole stream through.
  async function* tap(): AsyncIterable<Uint8Array> {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      hasher.write(chunk)
      sha.update(chunk)
      rawSize += chunk.length
      yield chunk
    }
  }

  const reader = await CarBlockIterator.fromIterable(tap())
  // Consume all blocks so the entire CAR flows through the hasher. Block data is
  // not retained; only its passage matters for the commitment.
  for await (const _block of reader) {
    // drain
  }
  const roots = await reader.getRoots()

  const digest = hasher.digest()
  const pieceCid = (Link.create(Raw.code, digest) as CID).toString()
  return { pieceCid, rawSize, sha256: sha.digest('hex'), roots }
}

export interface FetchAndComputeOptions {
  /** Opt-in fallback to a Helia bitswap walk when all gateways fail with a retriable category. */
  ipfsFallback?: boolean
  /** Upper bound on the Helia fallback fetch. Defaults to `DEFAULT_FALLBACK_TIMEOUT_MS`. */
  fallbackTimeoutMs?: number
}

/**
 * Retrieve a CID's DAG block-by-block from the first working gateway (each
 * block hash-verified), compute its PieceCID v2 over the locally serialized
 * canonical CAR, and verify the root matches the requested CID. Tries
 * gateways in order; the first whose walk completes wins. The winning
 * gateway's CAR URL is what the SP will later pull from — byte-identical to
 * the bytes hashed here.
 *
 * When `ipfsFallback` is enabled and every gateway fails with a retriable
 * category (5xx, 429, timeout, or CAR root mismatch), the function falls back
 * to a Helia bitswap + trustless-gateway-broker walk and assembles the CAR
 * locally. The result is verified by the same root-match check and the
 * sha256 of the returned bytes is recorded as the canonical signature for
 * future cross-source comparison.
 */
/**
 * The CAR-fetching surface `fetchAndComputePiece` depends on, injected so the
 * gateway-fallthrough, root-mismatch, and IPFS-fallback control flow can be
 * tested with in-memory CAR streams (no network). Production uses the real
 * gateway + Helia fetchers.
 */
export interface PieceFetchDeps {
  fetchCar: typeof fetchCanonicalCar
  fetchCarViaHelia: typeof fetchCarViaHelia
}

const defaultPieceFetchDeps: PieceFetchDeps = { fetchCar: fetchCanonicalCar, fetchCarViaHelia }

export async function fetchAndComputePiece(
  cid: string,
  gateways: string[],
  opts: FetchAndComputeOptions = {},
  deps: PieceFetchDeps = defaultPieceFetchDeps
): Promise<PieceResult> {
  const expected = CID.parse(cid)
  const errors: string[] = []
  const categories: FailureCategory[] = []

  for (const gateway of gateways) {
    try {
      const { url, body } = await deps.fetchCar(gateway, cid)
      const { pieceCid, rawSize, sha256, roots } = await computePiece(body)

      const rootMatch = roots.some((r) => r.equals(expected) || r.toString() === cid)
      if (!rootMatch) {
        throw new PieceComputeError(
          `CAR root mismatch: expected ${cid}, CAR declares [${roots.map((r) => r.toString()).join(', ')}]`,
          'car_root_mismatch'
        )
      }

      log(`  ok ${cid} source=gateway gateway=${gateway} sha256=${sha256.slice(0, 16)}…`)
      return { cid, pieceCid, rawSize, gateway, url, memberSha256: sha256, source: 'gateway' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${gateway}: ${message}`)
      categories.push(categoryOf(err))
      log(`  ! ${cid} via ${gateway} failed: ${message}`)
    }
  }

  // Pick the most-specific category seen across gateways. If every gateway
  // returned 429, the outer category is 429; if categories diverge, prefer any
  // non-`other` over `other`.
  const aggregated = categories.find((c) => c !== 'other') ?? 'other'

  if (opts.ipfsFallback === true && shouldFallback(aggregated)) {
    try {
      log(`  ↻ ${cid} falling back via embedded ipfs node (gateways exhausted: ${aggregated})`)
      const { body } = await deps.fetchCarViaHelia(cid, { timeoutMs: opts.fallbackTimeoutMs, gateways })
      const { pieceCid, rawSize, sha256, roots } = await computePiece(body)
      const rootMatch = roots.some((r) => r.equals(expected) || r.toString() === cid)
      if (!rootMatch) {
        throw new PieceComputeError(
          `CAR root mismatch via fallback: expected ${cid}, CAR declares [${roots.map((r) => r.toString()).join(', ')}]`,
          'car_root_mismatch'
        )
      }
      log(`  ok ${cid} source=helia sha256=${sha256.slice(0, 16)}…`)
      return { cid, pieceCid, rawSize, gateway: 'helia', url: '', memberSha256: sha256, source: 'helia' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`helia: ${message}`)
      log(`  ! ${cid} fallback failed: ${message}`)
    }
  }

  throw new PieceComputeError(`all sources failed for ${cid}\n    ${errors.join('\n    ')}`, aggregated)
}

/**
 * Record a computed piece, deciding whether it can actually be migrated.
 *
 * A piece served by a gateway carries a URL the storage provider's pull can
 * 302 to. A piece resolved only via the IPFS fallback has `source==='helia'`
 * and an empty URL: the provider pull is HTTP-only and has nothing to fetch, so
 * such a piece cannot complete a migration as the pipeline stands (serving the
 * bytes locally would be required). Recording it as a failure with a dedicated
 * category — rather than a `done` success that silently never migrates — keeps
 * `report` honest: the operator sees a clear terminal reason instead of a CID
 * stuck forever in "pending".
 *
 * Single chokepoint for both the streaming runner and `plan`, so neither can
 * record an unservable success.
 */
export function recordPieceOutcome(db: MigrationDB, cid: string, piece: PieceResult): void {
  if (piece.source === 'helia' && (piece.url == null || piece.url === '')) {
    db.recordPieceFailure(
      cid,
      'resolved only via the IPFS fallback (no gateway URL for the provider to pull); ' +
        'not migratable without serving the bytes locally',
      'unservable_fallback_only'
    )
    return
  }
  db.recordPieceSuccess(cid, piece.pieceCid, piece.rawSize, piece.gateway, piece.url, piece.memberSha256)
}

// Re-export so the runner can plumb the default through without importing helia directly.
export { DEFAULT_FALLBACK_TIMEOUT_MS }
