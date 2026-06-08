/**
 * Resilient block retrieval shared by the CLI and the browser app.
 *
 * A trustless gateway's load balancer hands each fresh connection to a
 * backend with its own cache, and a backend that misses returns 504 until its
 * upstream fetch lands — so a cold DAG needs bounded per-block retries, not a
 * failed walk. The helia stack underneath makes exactly one request per block
 * (verified: @helia/block-brokers src/trustless-gateway/trustless-gateway.ts
 * getRawBlock throws on the first non-OK response), and a failed probe EVICTS
 * the gateway from a blockstore session — after which a one-gateway session
 * never settles later gets, because its provider queue stays empty and the
 * event that resolves the promise never fires (verified: @helia/utils
 * src/abstract-session.ts retrieve). `retryingBlockSource` therefore retries
 * through the plain blockstore, not the dead session, and routes everything
 * after a first failure the same way.
 *
 * Only failure signatures known to be transient retry; a 404, a hash
 * mismatch, or an abort stays terminal and loud.
 */
import type { CID } from 'multiformats/cid'

/** Block bytes as the helia blockstore interface types them: bytes or a chunk generator. */
export type BlockBytes = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>

/** The reading surface of a helia blockstore or blockstore session. */
export interface BlockReader {
  get(cid: CID, options?: { signal?: AbortSignal }): BlockBytes | Promise<BlockBytes>
}

/** Every error message in a (possibly nested) AggregateError chain. */
export function messagesOf(err: unknown): string[] {
  if (err instanceof AggregateError) return err.errors.flatMap(messagesOf)
  return [err instanceof Error ? err.message : String(err)]
}

/**
 * True for failure signatures known to be transient at the gateway: a cold
 * backend answers 429/5xx until its upstream fetch caches the block, a
 * dropped connection surfaces as a fetch failure, and a failed probe leaves
 * the session's "… in session after evictions" message wearing the same
 * cold-start cause.
 */
export function isTransientBlockError(err: unknown): boolean {
  return messagesOf(err).some((m) =>
    /received (429|5\d\d) |Failed to fetch|fetch failed|in session after evictions/i.test(m)
  )
}

/** Normalize a blockstore read to plain bytes. */
export async function blockToBytes(value: BlockBytes): Promise<Uint8Array> {
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

const BLOCK_RETRY_DELAYS_MS = [1_000, 2_000, 4_000]

/**
 * A block source for the canonical exporter that reads through `session`
 * until the first transient failure, then through `direct` with backoff.
 * The exporter's lookahead keeps other blocks in flight while one backs off.
 */
export function retryingBlockSource(
  session: BlockReader,
  direct: BlockReader
): { get(cid: CID, options?: { signal?: AbortSignal }): Promise<Uint8Array> } {
  let sessionDead = false
  return {
    get: async (cid, opts) => {
      try {
        if (sessionDead) {
          return await blockToBytes(await direct.get(cid, opts))
        }
        return await blockToBytes(await session.get(cid, opts))
      } catch (err) {
        if (!isTransientBlockError(err)) throw err
        sessionDead = true
        let lastErr: unknown = err
        for (const delay of BLOCK_RETRY_DELAYS_MS) {
          await new Promise((resolve) => setTimeout(resolve, delay))
          if (opts?.signal?.aborted) break
          try {
            return await blockToBytes(await direct.get(cid, opts))
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
