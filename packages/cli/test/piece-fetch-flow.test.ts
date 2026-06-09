import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CarWriter } from '@ipld/car'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { CAR_ACCEPT, GatewayError } from '../src/gateway.ts'
import { categoryOf, fetchAndComputePiece, type PieceFetchDeps } from '../src/piece.ts'

// fetchAndComputePiece's gateway-fallthrough, root-mismatch, and IPFS-fallback
// control flow, exercised with in-memory CARs — no network.

async function makeCar(payload: string) {
  const data = new TextEncoder().encode(payload)
  const hash = await sha256.digest(data)
  const cid = CID.create(1, raw.code, hash)
  // CarWriter's CID generics trip on multiformats' ArrayBuffer/ArrayBufferLike
  // variance; the value is correct, so cast past the noise.
  const { writer, out } = CarWriter.create([cid] as never)
  const chunks: Uint8Array[] = []
  const collecting = (async () => {
    for await (const c of out) chunks.push(c)
  })()
  await writer.put({ cid, bytes: data } as never)
  await writer.close()
  await collecting
  return { cid, bytes: Buffer.concat(chunks.map((c) => Buffer.from(c))) }
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

function carResponse(bytes: Uint8Array, url: string) {
  return { url, body: streamOf(bytes), contentType: CAR_ACCEPT }
}

const noHelia: PieceFetchDeps['fetchCarViaHelia'] = async () => {
  throw new Error('helia should not be called')
}

test('a CAR whose root matches the CID computes a gateway-sourced piece', async () => {
  const { cid, bytes } = await makeCar('match')
  const deps: PieceFetchDeps = {
    fetchCar: async (gateway) => carResponse(bytes, `${gateway}/ipfs/${cid}`),
    fetchCarViaHelia: noHelia,
  }
  const r = await fetchAndComputePiece(cid.toString(), ['https://gw1'], {}, deps)
  assert.equal(r.source, 'gateway')
  assert.equal(r.gateway, 'https://gw1')
  assert.ok(r.pieceCid.length > 0)
  assert.ok(r.memberSha256)
})

test('a CAR whose root does not match the requested CID fails as car_root_mismatch', async () => {
  const wrong = await makeCar('this car is rooted elsewhere')
  const requested = await makeCar('but we asked for this one')
  const deps: PieceFetchDeps = {
    fetchCar: async (gateway) => carResponse(wrong.bytes, `${gateway}/x`),
    fetchCarViaHelia: noHelia,
  }
  await assert.rejects(
    () => fetchAndComputePiece(requested.cid.toString(), ['https://gw1'], {}, deps),
    (err: unknown) => {
      assert.equal(categoryOf(err), 'car_root_mismatch')
      return true
    }
  )
})

test('falls through to the next gateway when the first errors', async () => {
  const { cid, bytes } = await makeCar('second gateway wins')
  const deps: PieceFetchDeps = {
    fetchCar: async (gateway) => {
      if (gateway === 'https://gw1') {
        throw new GatewayError('gw1 down', { status: 503, category: 'source_gateway_5xx' })
      }
      return carResponse(bytes, `${gateway}/ipfs/${cid}`)
    },
    fetchCarViaHelia: noHelia,
  }
  const r = await fetchAndComputePiece(cid.toString(), ['https://gw1', 'https://gw2'], {}, deps)
  assert.equal(r.gateway, 'https://gw2')
  assert.equal(r.source, 'gateway')
})

test('every gateway failing aggregates the most-specific failure category', async () => {
  const { cid } = await makeCar('never served')
  const deps: PieceFetchDeps = {
    fetchCar: async () => {
      throw new GatewayError('429', { status: 429, category: 'source_gateway_429' })
    },
    fetchCarViaHelia: noHelia,
  }
  await assert.rejects(
    () => fetchAndComputePiece(cid.toString(), ['https://gw1', 'https://gw2'], {}, deps),
    (err: unknown) => {
      assert.equal(categoryOf(err), 'source_gateway_429')
      return true
    }
  )
})

test('with --ipfs-fallback, a retriable gateway exhaustion falls back to Helia', async () => {
  const { cid, bytes } = await makeCar('served by helia')
  let heliaCalled = false
  const deps: PieceFetchDeps = {
    fetchCar: async () => {
      throw new GatewayError('500', { status: 500, category: 'source_gateway_5xx' })
    },
    fetchCarViaHelia: async () => {
      heliaCalled = true
      return { body: streamOf(bytes), source: 'helia' }
    },
  }
  const r = await fetchAndComputePiece(cid.toString(), ['https://gw1'], { ipfsFallback: true }, deps)
  assert.equal(heliaCalled, true)
  assert.equal(r.source, 'helia')
  assert.equal(r.gateway, 'helia')
  assert.equal(r.url, '')
})

test('without --ipfs-fallback, gateway exhaustion does not call Helia', async () => {
  const { cid } = await makeCar('no fallback')
  let heliaCalled = false
  const deps: PieceFetchDeps = {
    fetchCar: async () => {
      throw new GatewayError('500', { status: 500, category: 'source_gateway_5xx' })
    },
    fetchCarViaHelia: async () => {
      heliaCalled = true
      return { body: streamOf(new Uint8Array()), source: 'helia' }
    },
  }
  await assert.rejects(() => fetchAndComputePiece(cid.toString(), ['https://gw1'], {}, deps))
  assert.equal(heliaCalled, false)
})
