/**
 * Canonical trustless-CAR URL shape and the gateways trusted to serve it.
 *
 * This is the one definition of how a CID maps to a byte-reproducible CAR URL.
 * The migrator computes a piece commitment over exactly these bytes, and the
 * storage provider's pull is later pointed at the same URL — so the migrator's
 * bytes ARE the provider's bytes. Anything that emits a pull target (the CLI
 * redirect server, the browser-dApp redirect relay) must build it from here,
 * never reimplement it: a second copy of this template that drifts would break
 * the byte-for-byte guarantee silently.
 *
 * Pure module — no `node:` imports, no DOM globals — so a Cloudflare Worker can
 * import it as-is.
 */

import { CID } from 'multiformats/cid'

/** Gateways known to serve deterministic, spec-compliant trustless CARs. */
export const DEFAULT_GATEWAYS = ['https://gateway.pinata.cloud', 'https://trustless-gateway.link']

export const CAR_ACCEPT = 'application/vnd.ipld.car'

/**
 * Build the canonical trustless-CAR URL for a CID. The query string pins every
 * variable the trustless-gateway spec exposes so byte output is reproducible
 * across fetches and gateways: full DAG scope, CAR v1 framing, depth-first
 * traversal order, no duplicate blocks. Without these, gateway defaults vary
 * (some emit CAR v2; some accept dup blocks), and the recomputed PieceCID will
 * diverge between plan and the provider's pull.
 */
export function buildCarUrl(gateway: string, cid: string): string {
  const base = gateway.replace(/\/+$/, '')
  return `${base}/ipfs/${cid}?format=car&dag-scope=all&car-version=1&car-order=dfs&car-dups=n`
}

/**
 * Hostnames of the built-in trusted gateways. The redirect relay only ever
 * emits a 302 to one of these hosts, so a client cannot turn it into an open
 * redirector. Derived from {@link DEFAULT_GATEWAYS} so the trust set has a
 * single source.
 */
export function defaultGatewayHosts(): string[] {
  return DEFAULT_GATEWAYS.map((g) => new URL(g).hostname)
}

/**
 * Build the stateless redirect-relay pull URL:
 * `{relayBase}/r/{gatewayHost}/{cid}/piece/{pieceCidV2}`.
 *
 * This is the single definition of the relay path shape — the submit side
 * builds it here and the relay (`relay/handler.ts`) parses the same shape, so
 * the two cannot drift. The relay reconstructs `buildCarUrl(gatewayHost, cid)`
 * from the prefix, so the provider's pull lands on the exact bytes the piece was
 * committed over; `pieceCid` is the suffix Curio's `ValidatePullSourceURL`
 * requires.
 */
export function relayPullUrl(relayBase: string, gatewayHost: string, cid: string, pieceCid: string): string {
  return `${relayBase.replace(/\/+$/, '')}/r/${gatewayHost}/${cid}/piece/${pieceCid}`
}

/**
 * Return `cid` iff it is already in canonical CIDv1 form — it parses and
 * round-trips to the byte-identical string. Returns null otherwise.
 *
 * The redirect relay embeds this exact string in `buildCarUrl`, and the browser
 * computed the piece commitment over `buildCarUrl(gateway, thisString)`. The CID
 * is the CAR's root, so a re-encoded CID (CIDv0 base58 vs CIDv1 base32, an
 * uppercase or alternate-base v1, any non-round-tripping form) produces
 * different CAR bytes and a different commP. Requiring round-trip identity — and
 * embedding the original string, never a re-serialized one — guarantees the
 * relay can only ever redirect to the URL the commitment was computed over. The
 * dApp must build its commP-fetch URL and its pull `sourceUrl` from this same
 * canonical string.
 */
export function canonicalCid(cid: string): string | null {
  let parsed: CID
  try {
    parsed = CID.parse(cid)
  } catch {
    return null
  }
  if (parsed.version !== 1) return null
  return parsed.toString() === cid ? cid : null
}
