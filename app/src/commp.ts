// Compute a Filecoin PieceCID v2 (commP) over the canonical trustless CAR for
// a CID, assembled in-browser from hash-verified blocks.
//
// The bytes hashed are NOT a raw gateway response. Blocks are retrieved
// individually through helia (which hash-verifies every block a broker
// returns) and serialized locally by the shared canonical exporter
// (`ipfs2foc-core/car-export`: CARv1, dag-scope=all, dfs, dups=n with an exact
// dedup set, bounded-lookahead prefetch). Because blocks are content-addressed,
// that serialization is byte-identical to what a spec-compliant gateway serves
// from `buildCarUrl` — the URL the provider later pulls — which is pinned by
// `test/car-export-byte-identity.test.ts` and the live PieceCID pins. Unlike
// hashing a gateway stream, a truncated or flaky source can never produce a
// commitment over incomplete bytes: an unavailable block fails the walk
// loudly.
//
// Threading: retrieval and CAR assembly run HERE on the main thread — one
// shared helia node for the whole session (per-piece nodes would discard
// broker/session state per CID, and a node inside a worker could never grow
// WebRTC transports: RTCPeerConnection exists only on Window). The CPU-bound
// fr32 hashing runs in pooled workers (`hash-pool.ts`), one core per
// concurrent piece, fed transferred chunks with per-chunk acknowledgement as
// backpressure.
//
// Memory stays bounded regardless of DAG size: the exporter holds at most
// `lookahead` blocks in flight, and the node's blockstore is a black hole so
// retrieved blocks are not retained after they are written to the CAR.
// Reuse the single source of truth (ipfs2foc-core) — never re-template these, or
// the relay redirect would drift from the bytes commP is computed over.
import { relayPullUrl, toCanonicalCidV1 } from 'ipfs2foc-core'
import { exportCanonicalCar } from 'ipfs2foc-core/car-export'
import { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import * as Digest from 'multiformats/hashes/digest'
import * as Link from 'multiformats/link'
import { beginHash } from './hash-pool.ts'

export interface PieceResult {
  cid: string
  pieceCid: string
  rawSize: number
  gatewayHost: string
  /** The pull URL a provider would be handed via the stateless relay. */
  sourceUrl: string
}

type HeliaNode = Awaited<ReturnType<typeof import('@helia/http')['createHeliaHTTP']>>

/** Every error message in a (possibly nested) AggregateError chain. */
function messagesOf(err: unknown): string[] {
  if (err instanceof AggregateError) return err.errors.flatMap(messagesOf)
  return [err instanceof Error ? err.message : String(err)]
}

/**
 * True for failure signatures known to be transient at the gateway: a cold
 * backend answers 429/5xx until its upstream fetch caches the block, and a
 * dropped connection surfaces as a fetch failure. A failed probe also EVICTS
 * the gateway from the session, so with one configured gateway the session's
 * InsufficientProvidersError ("… in session after evictions", verified:
 * @helia/utils src/abstract-session.ts findProviders) is the same cold-start
 * case wearing a different message. Anything else — a 404, a hash mismatch,
 * an abort — is terminal and must stay loud.
 */
function isTransientBlockError(err: unknown): boolean {
  return messagesOf(err).some((m) => /received (429|5\d\d) |Failed to fetch|in session after evictions/i.test(m))
}

export interface PrepareFailure {
  /** One line naming the action an operator takes. */
  headline: string
  /** The deduplicated underlying error chain, for inspection. */
  detail: string
}

/** Map a prepare failure to the action an operator takes (#34). */
export function describePrepareFailure(err: unknown): PrepareFailure {
  const msgs = messagesOf(err)
  const detail = [...new Set(msgs)].join(' ← ')
  const headline = (() => {
    if (msgs.some((m) => m === 'not a valid CID')) return 'not a valid CID'
    if (msgs.some((m) => /did not match multihash/.test(m))) {
      return 'gateway returned bytes that do not match the CID — switch gateway'
    }
    if (msgs.some((m) => /received (429|5\d\d) /.test(m))) {
      return 'gateway kept timing out on a block — likely not cached there; retry, or switch gateway'
    }
    if (msgs.some((m) => /received (404|410) /.test(m))) {
      return 'the gateway does not have this content — switch gateway'
    }
    if (msgs.some((m) => /Failed to fetch|NetworkError/i.test(m))) {
      return 'network failure while fetching — check connectivity and retry'
    }
    return msgs[0] ?? 'failed'
  })()
  return { headline, detail }
}

// Block fetches retry transient gateway failures before the walk fails: the
// gateway's load balancer hands each fresh connection to a backend with its
// own cache, and a backend that misses returns 504 until its upstream fetch
// lands (#36, observed live). The stack beneath makes exactly one request
// per block — TrustlessGateway.getRawBlock throws on the first non-OK
// response, and the session EVICTS a failed provider, leaving a one-gateway
// session empty (verified: @helia/block-brokers
// src/trustless-gateway/trustless-gateway.ts getRawBlock + broker.ts
// retrieve; @helia/utils src/abstract-session.ts retrieve) — so retries go
// through the plain blockstore, not the dead session. The exporter's
// lookahead keeps other blocks in flight while one backs off.
const BLOCK_RETRY_DELAYS_MS = [1_000, 2_000, 4_000]

type SessionBlockstore = ReturnType<HeliaNode['blockstore']['createSession']>

/** The blockstore interface types block bytes as bytes-or-chunk-generator; the exporter wants bytes. */
async function toBytes(value: Awaited<ReturnType<SessionBlockstore['get']>>): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of value) {
    chunks.push(chunk)
    total += chunk.length
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function retryingBlockSource(
  helia: HeliaNode,
  session: SessionBlockstore
): { get: (cid: CID, opts?: { signal?: AbortSignal }) => Promise<Uint8Array> } {
  // A transient failure evicts the session's only gateway, and a get through
  // an evicted one-gateway session never settles — its provider queue stays
  // empty so the event that resolves the promise never fires (verified:
  // @helia/utils src/abstract-session.ts retrieve resolves only from queue
  // events). After the first failure every block goes straight at the
  // blockstore, which probes the gateway per request.
  let sessionDead = false
  return {
    get: async (cid, opts) => {
      try {
        if (sessionDead) {
          return await toBytes(await helia.blockstore.get(cid, opts))
        }
        return await toBytes(await session.get(cid, opts))
      } catch (err) {
        if (!isTransientBlockError(err)) throw err
        sessionDead = true
        let lastErr: unknown = err
        for (const delay of BLOCK_RETRY_DELAYS_MS) {
          await new Promise((resolve) => setTimeout(resolve, delay))
          if (opts?.signal?.aborted) break
          try {
            return await toBytes(await helia.blockstore.get(cid, opts))
          } catch (retryErr) {
            lastErr = retryErr
            if (!isTransientBlockError(retryErr)) break
          }
        }
        throw lastErr
      }
    },
  }
}

// One node per gateway URL, kept for the session. With no libp2p transports
// the node is just the gateway block broker plus codec/hasher registries;
// switching gateways in the UI builds a new node and keeps the old one idle.
// The helia stack is imported lazily so the page paints without it — the
// node is only needed once Prepare runs.
const nodes = new Map<string, Promise<HeliaNode>>()

async function buildNode(gateway: string): Promise<HeliaNode> {
  const [{ createHeliaHTTP }, { trustlessGateway }, { httpGatewayRouting }, { BlackHoleBlockstore }] =
    await Promise.all([
      import('@helia/http'),
      import('@helia/block-brokers'),
      import('@helia/routers'),
      import('blockstore-core'),
    ])
  return createHeliaHTTP({
    blockstore: new BlackHoleBlockstore(),
    blockBrokers: [trustlessGateway()],
    // Routing scoped to the operator's configured gateway only — no
    // delegated routing, no default public gateway fan-out.
    routers: [httpGatewayRouting({ gateways: [gateway] })],
  })
}

function getHelia(gateway: string): Promise<HeliaNode> {
  let node = nodes.get(gateway)
  if (node == null) {
    node = buildNode(gateway)
    nodes.set(gateway, node)
  }
  return node
}

/**
 * Retrieve a CID's DAG block-by-block from the gateway (hash-verified), stream
 * the canonical CAR through a pooled piece hasher, and return the PieceCID v2
 * plus the relay pull URL. Streaming, constant-memory — the CAR is never
 * fully buffered.
 */
export async function computePiece(
  gateway: string,
  cidStr: string,
  relayBase: string,
  onProgress?: (bytes: number) => void
): Promise<PieceResult> {
  // Normalize to canonical CIDv1 (CIDv0 `Qm…` is converted automatically), then
  // export/commit/relay all under that one form so the commitment stays byte-safe.
  const canonical = toCanonicalCidV1(cidStr)
  if (canonical == null) {
    throw new Error('not a valid CID')
  }
  const root = CID.parse(canonical)

  const helia = await getHelia(gateway)
  const job = await beginHash()
  let rawSize = 0
  let pieceCid: string
  try {
    // Session scoped to the root: the gateway is probed for the root once and
    // reused for every block in the walk. Wrapped so a transient gateway
    // failure backs off and retries instead of killing the walk.
    const session = helia.blockstore.createSession(root)
    const source = retryingBlockSource(helia, session)
    for await (const chunk of exportCanonicalCar(source, helia.getCodec, root)) {
      rawSize += chunk.length
      await job.write(chunk)
      onProgress?.(rawSize)
    }

    // verified: fr32-sha2-256-trunc254-padded-binary-tree-multihash src/async.js
    // digest — multihash bytes come out via digestInto(bytes, 0, true).
    pieceCid = (Link.create(Raw.code, Digest.decode(await job.finish())) as CID).toString()
  } catch (err) {
    job.cancel()
    throw err
  }
  const gatewayHost = new URL(gateway).hostname
  const sourceUrl = relayPullUrl(relayBase, gatewayHost, canonical, pieceCid)

  return { cid: canonical, pieceCid, rawSize, gatewayHost, sourceUrl }
}
