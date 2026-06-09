/**
 * Stateless redirect relay for the in-browser BYOW migration dApp (#23).
 *
 * A browser tab cannot accept the inbound `/piece/{pieceCidV2}` pull a storage
 * provider's PDP makes, so the dApp points the provider at this shared,
 * multi-tenant relay, which 302-redirects each pull to the trustless-gateway CAR
 * the piece was committed over. No payload ever touches the relay — only the
 * 302 — and no state is stored anywhere.
 *
 * The routing is encoded entirely in the request path:
 *
 *     GET /r/{gatewayHost}/{cid}/piece/{pieceCidV2}
 *
 * Curio's pull validation (`pdp/pull_types.go#ValidatePullSourceURL`) only
 * requires the path to END with `/piece/{pieceCid}` (the regex is not
 * start-anchored) and the captured pieceCid to equal the on-chain value, over
 * HTTPS to a public host. So the dApp can prepend `/r/{gatewayHost}/{cid}` and
 * the relay recovers the routing from it — no registration, no KV, no TTL. The
 * relay rebuilds the gateway CAR URL with the same `buildCarUrl` the migrator
 * committed over, so the provider reads byte-identical bytes.
 *
 * Security: the relay never echoes a client-supplied URL into the redirect. The
 * `{gatewayHost}` segment must be an EXACT member of the allowlist (not a URL to
 * be parsed — a bare hostname, matched literally), and the `Location` is built
 * from the allowlist's own canonical string, so ports, userinfo (`@`), IDN
 * homographs, and percent-escapes cannot smuggle a different target. The `{cid}`
 * must be a canonical CIDv1 (round-trip identity) so the redirect can only point
 * at the exact bytes the commitment was computed over.
 */

import { buildCarUrl, canonicalCid, defaultGatewayHosts } from 'ipfs2foc-core'

export interface RelayEnv {
  /**
   * Optional comma-separated extra gateway hostnames to allow, on top of the
   * built-in {@link defaultGatewayHosts}. Lets an operator widen the trust set
   * by config rather than code. Host only — no scheme, port, or path.
   */
  ALLOWED_GATEWAY_HOSTS?: string
}

/** Reject absurdly long paths before any parsing. A valid route is well under this. */
const MAX_PATH_LENGTH = 512

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  })
}

/** The allowlist for this request: built-in trusted hosts plus any configured. */
function allowedHosts(env: RelayEnv): Set<string> {
  const extra = (env.ALLOWED_GATEWAY_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0)
  return new Set([...defaultGatewayHosts().map((h) => h.toLowerCase()), ...extra])
}

/**
 * Resolve `GET /r/{gatewayHost}/{cid}/piece/{pcid}` to a 302 at the gateway CAR.
 *
 * Parsing is strict and decode-free: the segments are split literally, any
 * percent-encoding is rejected (valid hostnames and CIDv1s never need it, and
 * not decoding closes the decode-then-reinterpret class of host smuggling), and
 * the arity/shape must match exactly. `{pcid}` is intentionally not validated —
 * it exists only to satisfy Curio's suffix rule and is the provider's check, not
 * the relay's.
 */
function handlePull(pathname: string, env: RelayEnv): Response {
  const parts = pathname.split('/')
  // ['', 'r', gatewayHost, cid, 'piece', pcid]
  if (parts.length !== 6 || parts[1] !== 'r' || parts[4] !== 'piece') return text('not found', 404)
  const [, , gatewayHostRaw, cidRaw, , pcid] = parts
  if (gatewayHostRaw.length === 0 || cidRaw.length === 0 || pcid.length === 0 || pathname.includes('%')) {
    return text('not found', 404)
  }

  // Exact, case-folded allowlist membership. The input is a bare hostname, not a
  // URL — matching it literally (rather than parsing `https://<seg>` and reading
  // .hostname) rejects ports, userinfo, IDN, and percent tricks in one stroke.
  const host = gatewayHostRaw.toLowerCase()
  if (!allowedHosts(env).has(host)) return text('gateway host not on allowlist', 403)

  // Canonical CIDv1 only: the redirect must embed the exact string the browser
  // hashed (the CID is the CAR root). Reject anything that does not round-trip.
  const cid = canonicalCid(cidRaw)
  if (cid == null) return text('not a canonical CIDv1', 404)

  // The redirect is built from the allowlisted host string and the canonical
  // CID — never from raw request bytes. `no-store` mirrors the CLI redirect
  // server so intermediaries do not pin the 302.
  const location = buildCarUrl(`https://${host}`, cid)
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } })
}

/**
 * The relay's request handler. A pure function of the request — no environment
 * state beyond the optional allowlist config. Kept in this (non-entry) module so
 * it can carry value exports; the thin `worker.ts` entry wires it in as `fetch`
 * (a Worker entry module may only export handlers).
 */
export function handle(request: Request, env: RelayEnv = {}): Response {
  const url = new URL(request.url)

  // Health check for monitors/ingress. GET or HEAD.
  if (url.pathname === '/healthz') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('method not allowed', 405)
    return text('ok', 200)
  }

  if (url.pathname.length > MAX_PATH_LENGTH) return text('not found', 404)

  if (url.pathname.startsWith('/r/')) {
    // HEAD is allowed: monitors and some clients probe the pull URL with it, and
    // a 302 carries no body anyway.
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('method not allowed', 405)
    return handlePull(url.pathname, env)
  }

  return text('not found', 404)
}
