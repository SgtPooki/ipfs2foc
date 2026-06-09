/**
 * Bitswap fallback for the trustless-gateway retrieval path.
 *
 * The migrator's normal source is a configured trustless gateway, fetched
 * directly as a CAR (`gateway.ts`). When every gateway fails with a retriable
 * category, this module retrieves the same CID's blocks over a bitswap-enabled
 * Helia node and serializes the CAR locally (`ipfs2foc-core/car-export`,
 * canonical framing, bounded-lookahead prefetch). Those bytes are
 * migrator-controlled —
 * the provider cannot pull a bitswap walk — so they feed the same
 * piece-commitment path but are recorded as `source==='helia'`, which
 * `recordPieceOutcome` treats as unservable by the provider pull.
 *
 * The bitswap node is built lazily on first fallback hit, so runs that never
 * engage the fallback pay nothing. The node uses `buildLibp2pConfig` and is torn
 * down by `stopVerifiedFetch`.
 *
 * Outbound-only libp2p: no listen addresses, TCP + WebSockets only, no WebRTC.
 *
 * `buildLibp2pConfig` is exported so `test/helia-config.test.ts` can assert the
 * WebRTC-free shape without standing up a node.
 */

import { exportCanonicalCarStream } from 'ipfs2foc-core/car-export'
import { CID } from 'multiformats/cid'
import { DEFAULT_GATEWAYS } from './gateway.ts'
import { fallbackHelia, stopVerifiedFetch } from './verified-fetch.ts'

/**
 * Build the libp2p init for the bitswap fallback node.
 *
 * Outbound-only: no listen addresses, so no inbound transports, no NAT
 * traversal, and no WebRTC. Transports are TCP and WebSockets, which together
 * reach the overwhelming majority of public bitswap providers and trustless
 * gateways advertised via delegated routing.
 */
export async function buildLibp2pConfig(): Promise<Record<string, any>> {
  const { tcp } = await import('@libp2p/tcp')
  const { webSockets } = await import('@libp2p/websockets')
  const { noise } = await import('@chainsafe/libp2p-noise')
  const { yamux } = await import('@libp2p/yamux')
  const { identify, identifyPush } = await import('@libp2p/identify')
  const { ping } = await import('@libp2p/ping')

  return {
    addresses: { listen: [] },
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      ping: ping(),
    },
  }
}

/** Default upper bound on a fallback fetch. The CLI exposes this as `--ipfs-fallback-timeout-seconds`. */
export const DEFAULT_FALLBACK_TIMEOUT_MS = 120_000

/**
 * Retrieve a CID's full DAG over the bitswap-enabled Helia node and emit a
 * CAR stream rooted at that CID, in canonical trustless-gateway framing
 * (`ipfs2foc-core/car-export`: DFS, dups=n, CARv1).
 *
 * Returns a `ReadableStream<Uint8Array>` so the caller can pipe it through the
 * same piece-commitment hasher used for gateway responses. The full reachable
 * DAG from the root is exported (`dag-scope=all` equivalent).
 *
 * Blocks are fetched through a blockstore session scoped to the root, so the
 * walk only talks to peers that answered for the root, with up to
 * `DEFAULT_LOOKAHEAD` block requests in flight ahead of the serializer.
 */
export async function fetchCarViaHelia(
  cid: string,
  opts: { timeoutMs?: number; gateways?: string[] } = {}
): Promise<{ body: ReadableStream<Uint8Array>; source: 'helia' }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS
  const root = CID.parse(cid)
  const helia = await fallbackHelia(opts.gateways ?? DEFAULT_GATEWAYS)
  const signal = AbortSignal.timeout(timeoutMs)
  const session = helia.blockstore.createSession(root, { signal })
  const body = exportCanonicalCarStream(session, helia.getCodec, root, { signal })
  return { body, source: 'helia' }
}

/**
 * Tear down the fallback node if one was started. Safe to call when none was
 * (e.g. a run that never engaged the fallback). Retained under the original name
 * so existing shutdown wiring keeps working; delegates to `stopVerifiedFetch`.
 */
export async function stopHeliaFallback(): Promise<void> {
  await stopVerifiedFetch()
}
