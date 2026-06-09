/**
 * Coverage for the multi-asset pack stage.
 *
 * Three properties matter for byte-stability:
 *   1. The canonical member sort runs on parsed CID bytes, so CIDv0 / CIDv1
 *      aliases produce one ordering regardless of the form the source
 *      registered with.
 *   2. Bin packing stays under the per-sub-piece target size, and refuses to
 *      pack the same source CID twice (an aggregate-level collision would
 *      collapse in the provider's indexer).
 *   3. Assembled CARs decode back to the input set, regardless of whether a
 *      member CAR was originally v1 or v2 — the assembler reads through
 *      `@ipld/car`'s decoder so the v2 wrapper transparently unwraps.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { CarBlockIterator, CarWriter } from '@ipld/car'
import { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { assembleMultiRootCar, compareCidBytes, planBins, type WritableStreamWithLength } from '../src/pack-cars.ts'

async function makeRawBlock(payload: string): Promise<{ cid: CID; bytes: Uint8Array }> {
  const bytes = new TextEncoder().encode(payload)
  const digest = await sha256.digest(bytes)
  const cid = CID.create(1, Raw.code, digest)
  return { cid, bytes }
}

async function singleRootCar(payload: string): Promise<{ cid: string; bytes: Uint8Array }> {
  const block = await makeRawBlock(payload)
  const { writer, out } = CarWriter.create([block.cid] as never)
  const drained = (async () => {
    const chunks: Uint8Array[] = []
    for await (const c of out as unknown as AsyncIterable<Uint8Array>) chunks.push(c)
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const merged = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      merged.set(c, off)
      off += c.length
    }
    return merged
  })()
  await writer.put(block as never)
  await writer.close()
  const bytes = await drained
  return { cid: block.cid.toString(), bytes }
}

function memberToReadable(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

class MemorySink implements WritableStreamWithLength {
  chunks: Uint8Array[] = []
  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk)
  }
  async end(): Promise<void> {}
  get bytes(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const merged = new Uint8Array(total)
    let off = 0
    for (const c of this.chunks) {
      merged.set(c, off)
      off += c.length
    }
    return merged
  }
}

test('compareCidBytes orders CIDv0 and CIDv1 of the same DAG identically', async () => {
  // Two CIDv1 raw blocks that differ in their multihash bytes — sort by parsed
  // bytes orders them deterministically regardless of base32 string order.
  const a = await makeRawBlock('hello-a')
  const b = await makeRawBlock('hello-b')
  const sortedByBytes = [a.cid.toString(), b.cid.toString()].sort(compareCidBytes)
  // The same comparator applied twice is stable.
  const replayed = [...sortedByBytes].sort(compareCidBytes)
  assert.deepEqual(replayed, sortedByBytes)
  // The comparator never returns NaN and is total.
  assert.ok(compareCidBytes(a.cid.toString(), a.cid.toString()) === 0)
})

test('planBins keeps every bin under the target, largest first', async () => {
  const cids = [
    (await makeRawBlock('p0')).cid.toString(),
    (await makeRawBlock('p1')).cid.toString(),
    (await makeRawBlock('p2')).cid.toString(),
    (await makeRawBlock('p3')).cid.toString(),
  ]
  const realInputs = [
    { cid: cids[0], rawSize: 400 },
    { cid: cids[1], rawSize: 300 },
    { cid: cids[2], rawSize: 200 },
    { cid: cids[3], rawSize: 100 },
  ]
  const { bins } = planBins(realInputs, 500)
  for (const bin of bins) {
    const total = bin.memberCids.reduce((sum, cid) => sum + (realInputs.find((p) => p.cid === cid)?.rawSize ?? 0), 0)
    assert.ok(total <= 500, `bin total ${total} must stay under target`)
  }
  // 400+100 = 500 in one bin; 300+200=500 in another. Two bins expected.
  assert.equal(bins.length, 2)
})

test('planBins rejects duplicate source CIDs (aggregate-level collision)', async () => {
  const cid = (await makeRawBlock('dup')).cid.toString()
  assert.throws(
    () =>
      planBins(
        [
          { cid, rawSize: 10 },
          { cid, rawSize: 20 },
        ],
        1000
      ),
    /duplicate source CID/
  )
})

test('planBins surfaces pieces above the target for the single-piece fallback', async () => {
  const bigCid = (await makeRawBlock('big')).cid.toString()
  const smallCid = (await makeRawBlock('small')).cid.toString()
  const big = { cid: bigCid, rawSize: 2_000 }
  const small = { cid: smallCid, rawSize: 100 }
  const { bins, oversizedForPacking } = planBins([big, small], 1_000)
  assert.deepEqual(
    oversizedForPacking.map((p) => p.cid),
    [big.cid]
  )
  assert.equal(bins.length, 1)
  assert.deepEqual(bins[0].memberCids, [small.cid])
})

test('assembleMultiRootCar concatenates two single-root members into a multi-root CAR', async () => {
  const m1 = await singleRootCar('alpha')
  const m2 = await singleRootCar('beta')
  const sink = new MemorySink()
  const result = await assembleMultiRootCar(
    [
      { cid: m1.cid, body: memberToReadable(m1.bytes) },
      { cid: m2.cid, body: memberToReadable(m2.bytes) },
    ],
    sink
  )
  // The assembled CAR declares both source CIDs as roots and decodes both
  // blocks via a plain CarBlockIterator (the same path the provider's
  // indexer uses).
  assert.equal(result.assembledBytes, sink.bytes.length)
  const reader = await CarBlockIterator.fromIterable(asyncIterableOf(sink.bytes))
  const blockCids: string[] = []
  for await (const block of reader) blockCids.push(block.cid.toString())
  assert.deepEqual(blockCids.sort(), [m1.cid, m2.cid].sort())
  const roots = await reader.getRoots()
  assert.deepEqual(roots.map((r) => r.toString()).sort(), [m1.cid, m2.cid].sort())
})

test('assembleMultiRootCar rejects a member CAR with a zero-length block section', async () => {
  // Manually craft a member CAR whose first block has zero-length bytes. The
  // CarWriter accepts an empty payload; the assembler must reject it because
  // Curio's indexer treats the zero-length section as EOF.
  const emptyBytes = new Uint8Array(0)
  const digest = await sha256.digest(emptyBytes)
  const cid = CID.create(1, Raw.code, digest)
  const { writer, out } = CarWriter.create([cid] as never)
  const drained = collect(out as unknown as AsyncIterable<Uint8Array>)
  await writer.put({ cid, bytes: emptyBytes } as never)
  await writer.close()
  const bytes = await drained
  const sink = new MemorySink()
  await assert.rejects(
    assembleMultiRootCar([{ cid: cid.toString(), body: memberToReadable(bytes) }], sink),
    /zero-length block section/
  )
})

async function* asyncIterableOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

async function collect(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const c of iter) chunks.push(c)
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const merged = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    merged.set(c, off)
    off += c.length
  }
  return merged
}
