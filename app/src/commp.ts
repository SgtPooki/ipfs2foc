// Compute a Filecoin PieceCID v2 (commP) over the canonical trustless CAR for
// a CID, assembled in-browser from hash-verified blocks.
//
// The bytes hashed are NOT a raw gateway response. The DAG is retrieved as a
// single streaming `?format=car&dag-scope=all` request per root
// (`ipfs2foc-core/car-stream-source`): a trustless gateway emits the CAR in the
// same depth-first, first-occurrence order the canonical exporter walks, so
// retrieval latency is paid once for the stream instead of once per block. Every
// block is hash-verified against its CID before it is served, and any block the
// stream never delivers falls through to a single verified `?format=raw` fetch;
// the bytes are then serialized locally by the shared canonical exporter
// (`ipfs2foc-core/car-export`: CARv1, dag-scope=all, dfs, dups=n with an exact
// dedup set, bounded-lookahead prefetch). Because blocks are content-addressed,
// that serialization is byte-identical to what a spec-compliant gateway serves
// from `buildCarUrl` — the URL the provider later pulls — which is pinned by
// `test/car-export-byte-identity.test.ts` and the live PieceCID pins. Unlike
// hashing a gateway stream, a truncated or flaky source can never produce a
// commitment over incomplete bytes: an unavailable block fails the walk
// loudly.
//
// This mirrors the CLI prepare path (`src/gateway-blocks.ts`): no helia node,
// pure `fetch` + `@ipld/car` + multiformats, so first paint stays light. The
// per-call `CarStreamSource` is scoped to one root and torn down (`close()`)
// when the export ends — no persistent broker/session state to carry across
// CIDs.
//
// Threading: retrieval and CAR assembly run HERE on the main thread; the
// CPU-bound fr32 hashing runs in pooled workers (`hash-pool.ts`), one core per
// concurrent piece, fed transferred chunks with per-chunk acknowledgement as
// backpressure.
//
// Memory stays bounded regardless of DAG size: the exporter holds at most
// `lookahead` blocks in flight, and the CAR-stream reorder buffer is a hard cap
// so retrieved blocks are not retained after they are written to the CAR.
// Reuse the single source of truth (ipfs2foc-core) — never re-template these, or
// the relay redirect would drift from the bytes commP is computed over.
import { relayPullUrl, toCanonicalCidV1 } from 'ipfs2foc-core'
import { messagesOf } from 'ipfs2foc-core/block-source'
import { exportCanonicalCar } from 'ipfs2foc-core/car-export'
import { CarStreamSource, defaultGetCodec } from 'ipfs2foc-core/car-stream-source'
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
  /**
   * Blocks the gateway's CAR stream did not cover, recovered per-block. A
   * non-zero count means the CAR the provider later pulls from the same URL was
   * incomplete for this root, so the operator should re-verify the gateway
   * before submitting — same warning the CLI logs.
   */
  gapFillCount: number
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
    if (msgs.some((m) => /stopped sending bytes/.test(m))) {
      return 'source stalled — not serving this CID right now; retry later'
    }
    return msgs[0] ?? 'failed'
  })()
  return { headline, detail }
}

/**
 * Race a promise against `signal`. The hash-worker protocol has no abort
 * channel — a request parked on a dead or suspended worker never settles — so
 * abort wins the race and the caller terminates the worker via `job.cancel()`
 * (the pool replaces it). The orphaned promise is dropped, not awaited.
 */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal == null) return p
  return new Promise<T>((resolve, reject) => {
    const reason = () => (signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError'))
    if (signal.aborted) {
      reject(reason())
      return
    }
    const onAbort = () => reject(reason())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

/**
 * Retrieve a CID's DAG from the gateway as one streaming CAR request per root
 * (hash-verified, per-block gap-fill on the side), stream the canonical CAR
 * through a pooled piece hasher, and return the PieceCID v2 plus the relay pull
 * URL. Streaming, constant-memory — the CAR is never fully buffered. The
 * `CarStreamSource` owns and closes its own stream, so there is no persistent
 * node to carry across calls.
 *
 * Aborting `signal` tears down the gateway stream, releases (and replaces) the
 * hash-pool worker, and rejects with the abort reason — the stall watchdog and
 * the per-row cancel both come through here (#43).
 */
export async function computePiece(
  gateway: string,
  cidStr: string,
  relayBase: string,
  onProgress?: (bytes: number) => void,
  signal?: AbortSignal
): Promise<PieceResult> {
  // Normalize to canonical CIDv1 (CIDv0 `Qm…` is converted automatically), then
  // export/commit/relay all under that one form so the commitment stays byte-safe.
  const canonical = toCanonicalCidV1(cidStr)
  if (canonical == null) {
    throw new Error('not a valid CID')
  }
  const root = CID.parse(canonical)

  // One streaming `?format=car` request per root; blocks served from the
  // verified stream, with a per-block `?format=raw` fallback for any the stream
  // misses. Scoped to this root and closed when the export ends.
  const source = new CarStreamSource(gateway, { signal })
  // If abort wins the acquire race, the late-resolving job still owns a pool
  // slot — cancel it on arrival so the slot is replaced, not leaked.
  const jobPromise = beginHash()
  jobPromise.then(
    (j) => {
      if (signal?.aborted === true) j.cancel()
    },
    () => {
      // surfaced through the raced await below
    }
  )
  let job: Awaited<typeof jobPromise> | null = null
  let rawSize = 0
  let pieceCid: string
  try {
    job = await raceAbort(jobPromise, signal)
    for await (const chunk of exportCanonicalCar(source, defaultGetCodec, root, { signal })) {
      rawSize += chunk.length
      await raceAbort(job.write(chunk), signal)
      onProgress?.(rawSize)
    }

    // verified: fr32-sha2-256-trunc254-padded-binary-tree-multihash src/async.js
    // digest — multihash bytes come out via digestInto(bytes, 0, true).
    pieceCid = (Link.create(Raw.code, Digest.decode(await raceAbort(job.finish(), signal))) as CID).toString()
  } catch (err) {
    job?.cancel()
    throw err
  } finally {
    source.close()
  }
  const gatewayHost = new URL(gateway).hostname
  const sourceUrl = relayPullUrl(relayBase, gatewayHost, canonical, pieceCid)

  return { cid: canonical, pieceCid, rawSize, gatewayHost, sourceUrl, gapFillCount: source.gapFillCount }
}
