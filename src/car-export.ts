/**
 * Canonical CAR export over a Helia blockstore with bounded-lookahead
 * prefetch.
 *
 * Produces the trustless-gateway CAR framing — CARv1, single root, DFS
 * pre-order, first-occurrence dedup (`dups=n`) — as a stream, while fetching
 * blocks ahead of the walk so retrieval latency overlaps instead of
 * serializing. The output is byte-identical to
 * `?format=car&dag-scope=all&car-version=1&car-order=dfs&car-dups=n` for the
 * same DAG: blocks are content-addressed, so only the serializer determines
 * the bytes, and this serializer mirrors the configuration validated against
 * the live gateway (see `test/car-export-byte-identity.test.ts`).
 *
 * Why not `@helia/verified-fetch`'s CAR response: its walker requests one
 * block per network round trip (verified: @helia/utils graph-walker.js
 * DepthFirstGraphWalker.getQueue — `concurrency: 1`), which serializes the
 * whole retrieval on per-block latency, and its `dups=n` dedup is a
 * probabilistic cuckoo filter (verified: @helia/verified-fetch
 * plugins/plugin-handle-car.js CarPlugin.handle —
 * `createScalableCuckooFilter`), where a false positive would silently drop
 * a block and corrupt the piece commitment. This module keeps the walk order
 * identical but issues up to `lookahead` block requests concurrently and
 * dedups with an exact set.
 *
 * Memory bound: `lookahead` in-flight blocks plus the dedup set (multihash
 * bytes only, ~40 B per unique block). No full-DAG buffering — emitted
 * blocks are released to the consumer immediately.
 */

import { CarWriter } from '@ipld/car'
import { base64 } from 'multiformats/bases/base64'
import { createUnsafe } from 'multiformats/block'
import type { BlockView } from 'multiformats/block/interface'
import type { CID } from 'multiformats/cid'

/**
 * The subset of a Helia blockstore (or session blockstore) the export needs.
 * `get` may resolve to the block bytes directly or to an (async) iterable of
 * chunks — helia's `Blocks.get` streams chunks (which is why
 * `@helia/utils graph-walker.js` wraps it in `it-to-buffer`).
 */
export interface BlockSource {
  get(
    cid: CID,
    options?: { signal?: AbortSignal }
  ):
    | Uint8Array
    | Promise<Uint8Array>
    | AsyncIterable<Uint8Array>
    | Iterable<Uint8Array>
    | Promise<AsyncIterable<Uint8Array>>
    | Promise<Iterable<Uint8Array>>
}

/** Normalize a `BlockSource.get` result to a single byte array. */
async function toBytes(result: ReturnType<BlockSource['get']>): Promise<Uint8Array> {
  const resolved = await result
  if (resolved instanceof Uint8Array) return resolved
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of resolved) {
    chunks.push(chunk)
    total += chunk.length
  }
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * `helia.getCodec` — resolves a codec implementation from a CID codec code.
 * May return the codec synchronously (helia's `CodecLoader` is
 * `Await<BlockCodec>`).
 */
export type GetCodec = (
  code: number
) =>
  | Promise<{ code: number; decode(bytes: Uint8Array): unknown }>
  | { code: number; decode(bytes: Uint8Array): unknown }

export interface ExportCanonicalCarOptions {
  /**
   * Maximum block fetches in flight ahead of the walk. Sized for many-small-
   * block DAGs (sharded directories): 32 × a typical 256 KiB UnixFS chunk is
   * ~8 MiB of lookahead, and bitswap's 2 MiB block ceiling caps the worst
   * case at 64 MiB.
   */
  lookahead?: number
  signal?: AbortSignal
}

export const DEFAULT_LOOKAHEAD = 32

const IDENTITY_MULTIHASH_CODE = 0x0

/** Exact dedup key: the multihash bytes, so CIDv0/v1 forms of a block collapse. */
function blockKey(cid: CID): string {
  return base64.encode(cid.multihash.bytes)
}

/**
 * Walk the DAG depth-first from `root` and emit CARv1 bytes in canonical
 * trustless-gateway framing. Blocks are fetched through `blocks.get` with up
 * to `lookahead` requests in flight ahead of the walk.
 */
export async function* exportCanonicalCar(
  blocks: BlockSource,
  getCodec: GetCodec,
  root: CID,
  opts: ExportCanonicalCarOptions = {}
): AsyncGenerator<Uint8Array, void, undefined> {
  const lookahead = opts.lookahead ?? DEFAULT_LOOKAHEAD
  const { signal } = opts
  // `as never`: the repo pins multiformats ^13 while @ipld/car types against
  // ^14; the runtime objects interoperate. Same boundary cast as
  // `pack-cars.ts` `CarWriter.create(roots as never)`.
  const { writer, out } = CarWriter.create([root] as never)

  const traversal = (async () => {
    try {
      await traverse(blocks, getCodec, root, writer, lookahead, signal)
    } finally {
      await writer.close()
    }
  })()
  // Surface the traversal error after the writer closes (below); without this
  // handler an early consumer break would leave the rejection unobserved.
  let traversalError: unknown
  traversal.catch((err) => {
    traversalError = err
  })

  for await (const chunk of out) {
    yield chunk
    if (traversalError != null) break
  }
  await traversal
}

/** `exportCanonicalCar` as a `ReadableStream`, for callers typed to fetch bodies. */
export function exportCanonicalCarStream(
  blocks: BlockSource,
  getCodec: GetCodec,
  root: CID,
  opts: ExportCanonicalCarOptions = {}
): ReadableStream<Uint8Array> {
  // ReadableStream.from ships in Node ≥20.6 (repo targets Node 26) but the
  // bundled DOM lib types don't declare it yet.
  const from = (ReadableStream as unknown as { from(it: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> }).from
  return from(exportCanonicalCar(blocks, getCodec, root, opts))
}

async function traverse(
  blocks: BlockSource,
  getCodec: GetCodec,
  root: CID,
  writer: Pick<import('@ipld/car').CarWriter, 'put'>,
  lookahead: number,
  signal?: AbortSignal
): Promise<void> {
  /** Multihashes already emitted (or queued for skip) — exact `dups=n`. */
  const seen = new Set<string>()
  /** DFS stack; top of stack is the next block in canonical order. */
  const stack: CID[] = [root]
  /** Prefetched block bodies, keyed like `seen`. Bounded by `lookahead`. */
  const inflight = new Map<string, Promise<Uint8Array>>()

  function pump(): void {
    let pending = 0
    for (let i = stack.length - 1; i >= 0 && pending < lookahead; i--) {
      const cid = stack[i]
      const key = blockKey(cid)
      if (seen.has(key)) continue
      if (cid.multihash.code === IDENTITY_MULTIHASH_CODE) continue
      pending++
      if (!inflight.has(key)) {
        const p = toBytes(blocks.get(cid, { signal }))
        // A prefetched fetch that fails before the walk reaches it must not
        // crash the process as an unhandled rejection; the walk re-awaits the
        // stored promise and surfaces the same error in order.
        p.catch(() => {
          // handled when the walk awaits the stored promise
        })
        inflight.set(key, p)
      }
    }
  }

  while (stack.length > 0) {
    signal?.throwIfAborted()
    pump()

    // biome-ignore lint/style/noNonNullAssertion: length checked above
    const cid = stack.pop()!
    const key = blockKey(cid)
    if (seen.has(key)) continue
    seen.add(key)

    let bytes: Uint8Array
    if (cid.multihash.code === IDENTITY_MULTIHASH_CODE) {
      // Identity blocks carry their bytes in the multihash digest and are not
      // written to the CAR (verified: @helia/car dist/src/car.js Car._export
      // skips IDENTITY_CODEC_CODE), but their links are still traversed.
      bytes = cid.multihash.digest
    } else {
      bytes = await (inflight.get(key) ?? toBytes(blocks.get(cid, { signal })))
      inflight.delete(key)
      // `as never`: multiformats ^13 vs @ipld/car's ^14 types; see the
      // CarWriter.create cast above.
      await writer.put({ cid, bytes } as never)
    }

    const codec = await getCodec(cid.code)
    const block = createUnsafe({ cid, bytes, codec }) as BlockView
    // Push child links in reverse so the first link is popped first (DFS
    // pre-order, matching the gateway's car-order=dfs).
    const links: CID[] = []
    for (const [, linked] of block.links()) {
      links.push(linked as CID)
    }
    for (let i = links.length - 1; i >= 0; i--) {
      if (!seen.has(blockKey(links[i]))) stack.push(links[i])
    }
  }
}
