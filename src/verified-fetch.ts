/**
 * Bitswap retrieval via `@helia/verified-fetch`.
 *
 * Used only by the opt-in IPFS fallback (`helia-fallback.ts`). The passthrough
 * commP path fetches the gateway's CAR directly (`gateway.ts`): the storage
 * provider pulls that same gateway URL, so the direct bytes are byte-safe by
 * construction and the fetch errors are plain, catchable HTTP/transport
 * failures. Verified-fetch earns its place only here, where the migrator walks
 * the DAG over bitswap and trustless-gateway brokers to recover a CID no gateway
 * could serve as a CAR.
 *
 * The node reuses `buildLibp2pConfig` from `helia-fallback.ts`: outbound-only,
 * TCP + WebSockets, no WebRTC. The native `node-datachannel` binding is built by
 * pnpm (`onlyBuiltDependencies`) so `@helia/verified-fetch` imports cleanly, but
 * the migrator only dials out, so WebRTC stays out of the dialed transports.
 */

import { createVerifiedFetchWithHelia, type VerifiedFetch } from '@helia/verified-fetch'

import { buildLibp2pConfig } from './helia-fallback.ts'

/** CAR media type with the framing options the trustless-gateway CAR pins. */
export const CAR_ACCEPT_FRAMED = 'application/vnd.ipld.car; version=1; order=dfs; dups=n'

type HeliaInstance = import('@helia/utils').Helia<any>

interface FetchHandle {
  helia: HeliaInstance
  fetch: VerifiedFetch
}

let fallbackHandle: Promise<FetchHandle> | null = null

/**
 * Swallow verified-fetch's background block-load orphans.
 *
 * When a fallback retrieval fails, the trustless-gateway session races several
 * block retrievers; the awaited retriever rejects (and the caller handles it),
 * but the losing retrievers reject too with no awaiter, surfacing as an
 * `unhandledRejection` that would otherwise crash the process. Verified, not
 * speculative: reproduced with a dead gateway, where the awaited error is caught
 * and exactly one orphan `LoadBlockFailedError` escapes. The handler is only
 * installed while a fallback node is alive, and anything that is not a known
 * verified-fetch block-load orphan is re-thrown unchanged.
 */
const VERIFIED_FETCH_ORPHAN_NAMES = new Set(['LoadBlockFailedError', 'InsufficientProvidersError', 'AbortError'])

function onUnhandledRejection(reason: unknown): void {
  if (VERIFIED_FETCH_ORPHAN_NAMES.has((reason as { name?: string })?.name ?? '')) return
  throw reason
}

let orphanGuardInstalled = false

function installOrphanGuard(): void {
  if (orphanGuardInstalled) return
  process.on('unhandledRejection', onUnhandledRejection)
  orphanGuardInstalled = true
}

function removeOrphanGuard(): void {
  if (!orphanGuardInstalled) return
  process.removeListener('unhandledRejection', onUnhandledRejection)
  orphanGuardInstalled = false
}

async function buildBitswapHelia(gateways: string[]): Promise<FetchHandle> {
  const { createLibp2p } = await import('libp2p')
  const { Helia } = await import('@helia/utils')
  const { trustlessGateway, bitswap } = await import('@helia/block-brokers')
  const { libp2pRouting, httpGatewayRouting, delegatedHTTPRouting, delegatedHTTPRoutingDefaults } = await import(
    '@helia/routers'
  )
  const { MemoryBlockstore } = await import('blockstore-core')
  const { MemoryDatastore } = await import('datastore-core')

  const libp2p = await createLibp2p(await buildLibp2pConfig())

  const helia = new Helia({
    libp2p,
    datastore: new MemoryDatastore(),
    blockstore: new MemoryBlockstore(),
    blockBrokers: [trustlessGateway(), bitswap()],
    routers: [
      libp2pRouting(libp2p),
      httpGatewayRouting({ gateways }),
      delegatedHTTPRouting(delegatedHTTPRoutingDefaults()),
    ],
  })
  await helia.start()
  const fetch = await createVerifiedFetchWithHelia(helia)
  return { helia, fetch }
}

/**
 * A bitswap-enabled verified-fetch for the fallback path. Lazily built on first
 * use; idle cost is zero on runs that never engage the fallback.
 */
export async function fallbackFetch(gateways: string[]): Promise<VerifiedFetch> {
  if (fallbackHandle == null) {
    installOrphanGuard()
    fallbackHandle = buildBitswapHelia(gateways)
  }
  return (await fallbackHandle).fetch
}

/** Tear down the fallback node if one was started. Safe to call when none was. */
export async function stopVerifiedFetch(): Promise<void> {
  if (fallbackHandle == null) return
  const handle = fallbackHandle
  fallbackHandle = null
  try {
    const { fetch, helia } = await handle
    await fetch.stop()
    await helia.stop()
  } finally {
    // Keep the guard a moment past teardown so in-flight losing retrievers that
    // reject after stop() still land on it rather than crashing the process.
    setTimeout(removeOrphanGuard, 1000).unref()
  }
}
