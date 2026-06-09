/**
 * Byte-identity guard for `ipfs2foc-core/car-export`.
 *
 * The reference serializer is `@helia/car`'s export configured exactly like
 * `@helia/verified-fetch`'s CAR handler for `dag-scope=all` —
 * `SubgraphExporter` over `depthFirstWalker` — but with an exact-set dedup
 * filter instead of the cuckoo filter. That configuration is pinned to the
 * live trustless gateway by `commp-piece-cid-regression.test.ts` (direct CAR)
 * and was shown byte-identical to the gateway CAR for bitswap-sourced blocks
 * on three real CIDs including the IPIP-499 HAMT golden (#27, 2026-06-05).
 * If `exportCanonicalCar` matches this reference on every DAG shape below,
 * it inherits that gateway equivalence.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { car as makeCar, SubgraphExporter } from '@helia/car'
import { depthFirstWalker } from '@helia/utils'
import { CarReader } from '@ipld/car'
import * as dagCbor from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import { MemoryBlockstore } from 'blockstore-core'
import { importBytes, importer } from 'ipfs-unixfs-importer'
import { exportCanonicalCar } from 'ipfs2foc-core/car-export'
import { CID } from 'multiformats/cid'
import * as json from 'multiformats/codecs/json'
import * as raw from 'multiformats/codecs/raw'
import { identity } from 'multiformats/hashes/identity'
import { sha256 } from 'multiformats/hashes/sha2'

const codecs: Record<number, { code: number; decode(b: Uint8Array): unknown }> = {
  [dagPb.code]: dagPb,
  [dagCbor.code]: dagCbor,
  [raw.code]: raw,
  [json.code]: json,
}
const getCodec = (code: number) => {
  const codec = codecs[code]
  if (codec == null) throw new Error(`no codec for 0x${code.toString(16)}`)
  return codec
}

const noopLogger = {
  forComponent: () => Object.assign(() => {}, { error() {}, trace() {}, enabled: false }),
} as never

const sha = (u8: Uint8Array) => createHash('sha256').update(u8).digest('hex')

function exactFilter() {
  const seen = new Set<string>()
  return {
    has: (b: Uint8Array) => seen.has(Buffer.from(b).toString('hex')),
    add: (b: Uint8Array) => {
      seen.add(Buffer.from(b).toString('hex'))
    },
  }
}

async function concat(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of iter) {
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

/** Reference bytes: the gateway-equivalent @helia/car configuration. */
async function referenceCar(blockstore: MemoryBlockstore, root: CID): Promise<Uint8Array> {
  const c = makeCar({ blockstore, getCodec, logger: noopLogger } as never)
  return concat(
    c.export(root as never, {
      exporter: new SubgraphExporter({ walker: depthFirstWalker() }),
      blockFilter: exactFilter(),
    }) as AsyncIterable<Uint8Array>
  )
}

async function canonicalCar(
  blockstore: MemoryBlockstore,
  root: CID,
  opts: { lookahead?: number } = {}
): Promise<Uint8Array> {
  return concat(exportCanonicalCar(blockstore, getCodec, root, opts))
}

async function putBlock(
  blockstore: MemoryBlockstore,
  codec: { code: number; encode(value: never): Uint8Array },
  value: unknown
): Promise<CID> {
  const bytes = codec.encode(value as never)
  const cid = CID.create(1, codec.code, await sha256.digest(bytes))
  await blockstore.put(cid, bytes)
  return cid
}

/** deterministic bytes without Math.random */
function payload(n: number, seed = 0x2545f491): Uint8Array {
  const u8 = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    u8[i] = x & 0xff
  }
  return u8
}

test('multi-block unixfs file matches the gateway-equivalent reference', async () => {
  const blockstore = new MemoryBlockstore()
  const { cid } = await importBytes(payload(3 * 1024 * 1024), blockstore)
  const root = CID.parse(cid.toString())
  const [mine, ref] = [await canonicalCar(blockstore, root), await referenceCar(blockstore, root)]
  assert.equal(sha(mine), sha(ref))
  assert.equal(mine.length, ref.length)
})

test('unixfs directory with shared leaves dedups like dups=n', async () => {
  const blockstore = new MemoryBlockstore()
  let last: { cid: { toString(): string } } | undefined
  const shared = payload(600 * 1024)
  for await (const entry of importer(
    [
      { path: 'dir/a.bin', content: shared },
      { path: 'dir/b.bin', content: shared }, // same bytes -> shared leaf blocks
      { path: 'dir/sub/c.bin', content: payload(64, 7) },
    ],
    blockstore,
    { wrapWithDirectory: true }
  )) {
    last = entry
  }
  assert.ok(last)
  const root = CID.parse(last.cid.toString())
  const [mine, ref] = [await canonicalCar(blockstore, root), await referenceCar(blockstore, root)]
  assert.equal(sha(mine), sha(ref))

  // and the shared leaf appears exactly once
  const reader = await CarReader.fromBytes(mine)
  const seen = new Map<string, number>()
  for await (const { cid } of reader.blocks()) {
    seen.set(cid.toString(), (seen.get(cid.toString()) ?? 0) + 1)
  }
  for (const [cidStr, count] of seen) {
    assert.equal(count, 1, `block ${cidStr} emitted ${count} times`)
  }
})

test('sharded (HAMT-style fanout) directory matches the reference', async () => {
  const blockstore = new MemoryBlockstore()
  let last: { cid: { toString(): string } } | undefined
  const entries = Array.from({ length: 64 }, (_, i) => ({
    path: `dir/file-${i}.bin`,
    content: payload(128, i + 1),
  }))
  for await (const entry of importer(entries, blockstore, {
    wrapWithDirectory: true,
    // force sharding with a small threshold so the dir becomes a HAMT
    shardSplitThresholdBytes: 256,
  })) {
    last = entry
  }
  assert.ok(last)
  const root = CID.parse(last.cid.toString())
  const [mine, ref] = [await canonicalCar(blockstore, root), await referenceCar(blockstore, root)]
  assert.equal(sha(mine), sha(ref))
})

test('dag-cbor root with nested links matches the reference', async () => {
  const blockstore = new MemoryBlockstore()
  const leafA = await putBlock(blockstore, raw, payload(32, 1))
  const leafB = await putBlock(blockstore, raw, payload(32, 2))
  const mid = await putBlock(blockstore, dagCbor, { a: leafA, b: leafB })
  const root = await putBlock(blockstore, dagCbor, { left: mid, right: leafB, again: leafA })
  const [mine, ref] = [await canonicalCar(blockstore, root), await referenceCar(blockstore, root)]
  assert.equal(sha(mine), sha(ref))
})

test('identity-multihash links are traversed but not emitted, like @helia/car', async () => {
  const blockstore = new MemoryBlockstore()
  const leaf = await putBlock(blockstore, raw, payload(32, 3))
  // identity CID whose inline dag-cbor bytes link to the leaf
  const inlineBytes = dagCbor.encode({ to: leaf })
  const identityCid = CID.create(1, dagCbor.code, identity.digest(inlineBytes))
  // the reference walker reads identity blocks from the blockstore, so put it
  await blockstore.put(identityCid, inlineBytes)
  const root = await putBlock(blockstore, dagCbor, { via: identityCid })
  const [mine, ref] = [await canonicalCar(blockstore, root), await referenceCar(blockstore, root)]
  assert.equal(sha(mine), sha(ref))
  // identity block absent, linked leaf present
  const reader = await CarReader.fromBytes(mine)
  const cids: string[] = []
  for await (const { cid } of reader.blocks()) cids.push(cid.toString())
  assert.ok(!cids.includes(identityCid.toString()), 'identity block must not be written')
  assert.ok(cids.includes(leaf.toString()), 'identity-linked leaf must be reachable')
})

test('output declares exactly the requested root', async () => {
  const blockstore = new MemoryBlockstore()
  const { cid } = await importBytes(payload(1024), blockstore)
  const root = CID.parse(cid.toString())
  const reader = await CarReader.fromBytes(await canonicalCar(blockstore, root))
  const roots = await reader.getRoots()
  assert.equal(roots.length, 1)
  assert.equal(roots[0].toString(), root.toString())
})

test('lookahead is bounded and does not change the bytes', async () => {
  const blockstore = new MemoryBlockstore()
  const { cid } = await importBytes(payload(2 * 1024 * 1024), blockstore)
  const root = CID.parse(cid.toString())

  const LOOKAHEAD = 4
  let inFlight = 0
  let peak = 0
  const counting = {
    async get(cidArg: CID, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
      inFlight++
      peak = Math.max(peak, inFlight)
      try {
        // hold the request across a tick so concurrent prefetches overlap
        await new Promise((resolve) => setTimeout(resolve, 1))
        const chunks: Uint8Array[] = []
        for await (const c of blockstore.get(cidArg, options) as AsyncIterable<Uint8Array>) chunks.push(c)
        return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
      } finally {
        inFlight--
      }
    },
  }

  const bounded = await concat(exportCanonicalCar(counting, getCodec, root, { lookahead: LOOKAHEAD }))
  assert.ok(peak <= LOOKAHEAD, `peak in-flight ${peak} exceeded lookahead ${LOOKAHEAD}`)
  assert.ok(peak > 1, `prefetch never overlapped (peak ${peak}); lookahead is not pipelining`)

  const serial = await canonicalCar(blockstore, root, { lookahead: 1 })
  const wide = await canonicalCar(blockstore, root, { lookahead: 64 })
  assert.equal(sha(bounded), sha(serial))
  assert.equal(sha(bounded), sha(wide))
})

test('a failing block fetch rejects the export instead of hanging', async () => {
  const blockstore = new MemoryBlockstore()
  const { cid } = await importBytes(payload(512 * 1024), blockstore)
  const root = CID.parse(cid.toString())
  let calls = 0
  const failing = {
    async get(cidArg: CID, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
      calls++
      if (calls > 1) throw new Error('synthetic block fetch failure')
      const chunks: Uint8Array[] = []
      for await (const c of blockstore.get(cidArg, options) as AsyncIterable<Uint8Array>) chunks.push(c)
      return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
    },
  }
  await assert.rejects(concat(exportCanonicalCar(failing, getCodec, root)), /synthetic block fetch failure/)
})
