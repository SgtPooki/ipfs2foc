/**
 * Trustless gateway access (Mode A).
 *
 * Each CID is fetched as a CAR via the IPFS Trustless Gateway spec
 * (`?format=car&dag-scope=all`). The returned CAR is rooted at the original
 * CID, so storing it preserves the CID without re-chunking. The redirect server
 * later points the provider's pull at this same URL, so the provider reads
 * byte-identical bytes and computes the same piece commitment.
 */

import { createHash } from 'node:crypto'

/** Gateways that are known to serve deterministic, spec-compliant trustless CARs. */
export const DEFAULT_GATEWAYS = ['https://gateway.pinata.cloud', 'https://trustless-gateway.link']

export const CAR_ACCEPT = 'application/vnd.ipld.car'

/**
 * Build the canonical trustless-CAR URL for a CID. `dag-scope=all` requests the
 * full DAG; `dups=n` (the gateway default) keeps the CAR free of duplicate
 * blocks. These params are pinned so the bytes are reproducible across fetches.
 */
export function buildCarUrl(gateway: string, cid: string): string {
  const base = gateway.replace(/\/+$/, '')
  return `${base}/ipfs/${cid}?format=car&dag-scope=all`
}

/** Fetch a CID as a CAR stream. Throws on non-2xx or a non-CAR content-type. */
export async function fetchCar(
  gateway: string,
  cid: string,
  signal?: AbortSignal
): Promise<{ url: string; body: ReadableStream<Uint8Array>; contentType: string }> {
  const url = buildCarUrl(gateway, cid)
  const res = await fetch(url, { headers: { accept: CAR_ACCEPT }, signal })
  if (!res.ok) {
    throw new Error(`gateway ${gateway} returned HTTP ${res.status} for ${cid}`)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/vnd.ipld.car')) {
    // A file-mode gateway ignores ?format=car and returns the reassembled file.
    // That is unusable for CID preservation, so reject it loudly.
    throw new Error(
      `gateway ${gateway} is not trustless: got content-type "${contentType}" instead of a CAR for ${cid}`
    )
  }
  if (res.body == null) {
    throw new Error(`gateway ${gateway} returned an empty body for ${cid}`)
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
