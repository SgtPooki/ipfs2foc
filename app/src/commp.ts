// Compute a Filecoin PieceCID v2 (commP) over the canonical trustless CAR for
// a CID, assembled in-browser from hash-verified blocks.
//
// The bytes hashed here are NOT a raw gateway response. Blocks are retrieved
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
// Memory stays bounded regardless of DAG size: the exporter holds at most
// `lookahead` blocks in flight, and the node's blockstore is a black hole so
// retrieved blocks are not retained after they are written to the CAR.
//
// The piece hasher is the Rust/WASM fr32 multihash (same multihash code 0x1011
// as @web3-storage/data-segment/multihash, which src/piece.ts uses) — measured
// ~2x the throughput of the JS implementation (20 -> 39 MiB/s on Apple
// Silicon). PieceCID parity with the JS hasher is pinned by
// test/commp-wasm-parity.test.ts.
import { trustlessGateway } from '@helia/block-brokers'
import { createHeliaHTTP } from '@helia/http'
import { httpGatewayRouting } from '@helia/routers'
import { BlackHoleBlockstore } from 'blockstore-core'
import { create as createHasher } from 'fr32-sha2-256-trunc254-padded-binary-tree-multihash'
// Reuse the single source of truth (ipfs2foc-core) — never re-template these, or
// the relay redirect would drift from the bytes commP is computed over.
import { relayPullUrl, toCanonicalCidV1 } from 'ipfs2foc-core'
import { exportCanonicalCar } from 'ipfs2foc-core/car-export'
import { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import * as Digest from 'multiformats/hashes/digest'
import * as Link from 'multiformats/link'

export interface PieceResult {
  cid: string
  pieceCid: string
  rawSize: number
  gatewayHost: string
  /** The pull URL a provider would be handed via the stateless relay. */
  sourceUrl: string
}

/**
 * Retrieve a CID's DAG block-by-block from the gateway (hash-verified), stream
 * the canonical CAR through the piece hasher, and return the PieceCID v2 plus
 * the relay pull URL. Streaming, constant-memory — the CAR is never fully
 * buffered.
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

  // One throwaway node per piece: the worker is per-CID and terminated after,
  // and with no libp2p transports the node is just the gateway block broker.
  // Routing is scoped to the operator's configured gateway only.
  const helia = await createHeliaHTTP({
    blockstore: new BlackHoleBlockstore(),
    blockBrokers: [trustlessGateway()],
    routers: [httpGatewayRouting({ gateways: [gateway] })],
  })

  // WASM hasher holds memory outside the JS heap; free() in the finally below
  // covers both the success path and a throw mid-stream.
  const hasher = createHasher()
  let rawSize = 0
  let pieceCid: string
  try {
    // Session scoped to the root: the gateway is probed for the root once and
    // reused for every block in the walk.
    const session = helia.blockstore.createSession(root)
    for await (const chunk of exportCanonicalCar(session, helia.getCodec, root)) {
      hasher.write(chunk)
      rawSize += chunk.length
      onProgress?.(rawSize)
    }

    // verified: fr32-sha2-256-trunc254-padded-binary-tree-multihash src/async.js
    // digest — multihash bytes come out via digestInto(bytes, 0, true).
    const out = new Uint8Array(hasher.multihashByteLength())
    hasher.digestInto(out, 0, true)
    pieceCid = (Link.create(Raw.code, Digest.decode(out)) as CID).toString()
  } finally {
    hasher.free()
    await helia.stop()
  }
  const gatewayHost = new URL(gateway).hostname
  const sourceUrl = relayPullUrl(relayBase, gatewayHost, canonical, pieceCid)

  return { cid: canonical, pieceCid, rawSize, gatewayHost, sourceUrl }
}
