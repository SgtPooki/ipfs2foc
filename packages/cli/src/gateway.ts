/**
 * Trustless gateway access.
 *
 * Each CID is fetched as a CAR via the IPFS Trustless Gateway spec
 * (`?format=car&dag-scope=all`). The returned CAR is rooted at the original
 * CID, so storing it preserves the CID without re-chunking. The redirect server
 * later points the provider's pull at this same URL, so the provider reads
 * byte-identical bytes and computes the same piece commitment.
 */

import { createHash } from 'node:crypto'
import { buildCarUrl, CAR_ACCEPT, DEFAULT_GATEWAYS } from 'ipfs2foc-core'
import type { FailureCategory } from './db.ts'

// Re-export the canonical CAR-URL surface so existing importers of `./gateway`
// keep working; the definitions now live in `./car-url` (pure, Worker-safe) so
// the redirect relay can share them without pulling in node:crypto. See
// `car-url.ts` for why this must be a single source of truth.
export { buildCarUrl, CAR_ACCEPT, DEFAULT_GATEWAYS }

/**
 * Error subclass thrown by `fetchCar` so callers can categorize failures by
 * the HTTP status code instead of pattern-matching the error message.
 */
export class GatewayError extends Error {
  status?: number
  category: FailureCategory
  constructor(message: string, opts: { status?: number; category: FailureCategory }) {
    super(message)
    this.name = 'GatewayError'
    this.status = opts.status
    this.category = opts.category
  }
}

function categoryForStatus(status: number): FailureCategory {
  if (status === 429) return 'source_gateway_429'
  if (status >= 500 && status < 600) return 'source_gateway_5xx'
  return 'other'
}

function categoryForFetchError(err: unknown): FailureCategory {
  // node:fetch wraps transport errors in a TypeError whose `cause` carries the
  // node:net / dns / undici code. The signal-aborted case surfaces as a
  // DOMException with name='AbortError'. Walk the chain rather than grep the
  // message string.
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur != null && !seen.has(cur)) {
    seen.add(cur)
    const name = (cur as { name?: string }).name
    if (name === 'AbortError' || name === 'TimeoutError') return 'source_gateway_timeout'
    const code = (cur as { code?: string }).code
    if (
      code === 'ETIMEDOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT'
    )
      return 'source_gateway_timeout'
    if (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENETUNREACH' ||
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'UND_ERR_SOCKET'
    )
      return 'source_gateway_network'
    cur = (cur as { cause?: unknown }).cause
  }
  return 'source_gateway_network'
}

/** Fetch a CID as a CAR stream. Throws on non-2xx or a non-CAR content-type. */
export async function fetchCar(
  gateway: string,
  cid: string,
  signal?: AbortSignal
): Promise<{ url: string; body: ReadableStream<Uint8Array>; contentType: string }> {
  const url = buildCarUrl(gateway, cid)
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: CAR_ACCEPT }, signal })
  } catch (err) {
    throw new GatewayError(
      `gateway ${gateway} fetch failed for ${cid}: ${err instanceof Error ? err.message : String(err)}`,
      { category: categoryForFetchError(err) }
    )
  }
  if (!res.ok) {
    throw new GatewayError(`gateway ${gateway} returned HTTP ${res.status} for ${cid}`, {
      status: res.status,
      category: categoryForStatus(res.status),
    })
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/vnd.ipld.car')) {
    // A file-mode gateway ignores ?format=car and returns the reassembled file.
    // That is unusable for CID preservation, so reject it loudly.
    throw new GatewayError(
      `gateway ${gateway} is not trustless: got content-type "${contentType}" instead of a CAR for ${cid}`,
      { status: res.status, category: 'other' }
    )
  }
  if (res.body == null) {
    throw new GatewayError(`gateway ${gateway} returned an empty body for ${cid}`, {
      status: res.status,
      category: 'other',
    })
  }
  return { url, body: res.body, contentType }
}

export interface ProbeResult {
  gateway: string
  cid: string
  servesCar: boolean
  deterministic: boolean
  contentType: string
  bytes: number
  sha256: string
  note?: string
}

/**
 * Probe a gateway for a CID: confirm it serves a CAR and that two independent
 * fetches are byte-identical (the determinism the SP pull relies on).
 */
export async function probeGateway(gateway: string, cid: string): Promise<ProbeResult> {
  const first = await fetchCar(gateway, cid)
  const firstDigest = await hashStream(first.body)

  const second = await fetchCar(gateway, cid)
  const secondDigest = await hashStream(second.body)

  const deterministic = firstDigest.sha256 === secondDigest.sha256
  return {
    gateway,
    cid,
    servesCar: true,
    deterministic,
    contentType: first.contentType,
    bytes: firstDigest.bytes,
    sha256: firstDigest.sha256,
    note: deterministic ? undefined : `two fetches differed: ${firstDigest.sha256} vs ${secondDigest.sha256}`,
  }
}

async function hashStream(body: ReadableStream<Uint8Array>): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { sha256: hash.digest('hex'), bytes }
}
