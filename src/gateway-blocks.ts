/**
 * Block-verified gateway retrieval for the prepare path (#30).
 *
 * `gateway.ts` fetches a CID's CAR as one HTTP response, and a response that
 * ends early at a block boundary parses cleanly — observed live when a
 * gateway served 257 KiB of a 5 MB DAG with a valid root and clean framing,
 * yielding a commitment over incomplete bytes. This module retrieves the DAG
 * block-by-block instead (each block hash-verified by helia against its CID)
 * and serializes the canonical CAR locally (`ipfs2foc-core/car-export`), so
 * an unavailable or truncated block fails the walk loudly and the bytes
 * hashed are byte-identical to what a spec-compliant gateway serves at the
 * recorded URL — the same property the browser console ships on.
 *
 * One helia node per gateway URL, no libp2p: just the trustless-gateway
 * block broker scoped to that single gateway, with a black-hole blockstore
 * so retrieved blocks are not retained after they reach the serializer.
 * Block fetches go through `retryingBlockSource`
 * (`ipfs2foc-core/block-source`) so a cold gateway backend gets bounded
 * retries instead of failing the piece.
 */

import { buildCarUrl } from 'ipfs2foc-core'
import { messagesOf, retryingBlockSource } from 'ipfs2foc-core/block-source'
import { exportCanonicalCar } from 'ipfs2foc-core/car-export'
import { CID } from 'multiformats/cid'
import type { FailureCategory } from './db.ts'
import { GatewayError } from './gateway.ts'

type HeliaHTTP = Awaited<ReturnType<typeof import('@helia/http')['createHeliaHTTP']>>

// One node per gateway URL, kept for the run. Lazily built so commands that
// never prepare pay nothing.
const nodes = new Map<string, Promise<HeliaHTTP>>()

async function buildNode(gateway: string): Promise<HeliaHTTP> {
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
    // Scoped to the one gateway whose URL the provider will pull from — no
    // delegated routing, no public-gateway fan-out. The commitment must be
    // computable from that gateway alone, or the pull cannot match it.
    routers: [httpGatewayRouting({ gateways: [gateway] })],
  })
}

function gatewayHelia(gateway: string): Promise<HeliaHTTP> {
  let node = nodes.get(gateway)
  if (node == null) {
    node = buildNode(gateway)
    nodes.set(gateway, node)
  }
  return node
}

/**
 * Map a broker/walk failure onto the gateway failure categories that drive
 * retry, fallback, and reporting. The broker folds HTTP status into the
 * error message ("… received 504 Gateway Timeout"; verified:
 * @helia/block-brokers src/trustless-gateway/trustless-gateway.ts
 * getRawBlock), so the status is recovered from the message chain. A hash
 * mismatch maps to `car_root_mismatch` — bad bytes from this gateway, the
 * same remediation as a wrong root. The session's post-eviction message is
 * the cold-backend case and maps with the 5xx family.
 */
export function categorizeBlockError(err: unknown): FailureCategory {
  const msgs = messagesOf(err)
  const statusMatch = msgs.map((m) => /received (\d{3}) /.exec(m)).find((m) => m != null)
  const status = statusMatch == null ? null : Number(statusMatch[1])
  if (status === 429) return 'source_gateway_429'
  if (status != null && status >= 500 && status < 600) return 'source_gateway_5xx'
  if (msgs.some((m) => /in session after evictions/i.test(m))) return 'source_gateway_5xx'
  if (msgs.some((m) => /aborted/i.test(m))) return 'source_gateway_timeout'
  if (msgs.some((m) => /fetch failed|Failed to fetch/i.test(m))) return 'source_gateway_network'
  if (msgs.some((m) => /did not match multihash/.test(m))) return 'car_root_mismatch'
  return 'other'
}

/**
 * Retrieve a CID's DAG block-by-block from one gateway and emit the
 * canonical CAR stream. Shape-compatible with `gateway.ts` `fetchCar`: the
 * recorded `url` is the gateway CAR URL the provider later pulls, and `body`
 * carries the byte-identical canonical serialization. Failures — at start or
 * mid-stream — surface as `GatewayError` with a mapped category.
 */
export async function fetchCanonicalCar(
  gateway: string,
  cid: string,
  signal?: AbortSignal
): Promise<{ url: string; body: ReadableStream<Uint8Array> }> {
  const url = buildCarUrl(gateway, cid)
  const root = CID.parse(cid)
  const helia = await gatewayHelia(gateway)
  const session = helia.blockstore.createSession(root)
  const source = retryingBlockSource(session, helia.blockstore)

  async function* translated(): AsyncIterable<Uint8Array> {
    try {
      yield* exportCanonicalCar(source, helia.getCodec, root, { signal })
    } catch (err) {
      if (err instanceof GatewayError) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new GatewayError(`gateway ${gateway} block walk failed for ${cid}: ${message}`, {
        category: categorizeBlockError(err),
      })
    }
  }

  const from = (ReadableStream as unknown as { from(it: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> }).from
  return { url, body: from(translated()) }
}

/** Stop any per-gateway nodes a run started. Safe to call when none were. */
export async function stopGatewayBlocks(): Promise<void> {
  const stopping = [...nodes.values()].map(async (p) => (await p).stop())
  nodes.clear()
  await Promise.allSettled(stopping)
}
