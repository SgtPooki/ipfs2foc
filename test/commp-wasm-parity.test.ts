import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as JsHasher from '@web3-storage/data-segment/multihash'
// The browser app (app/src/commp.ts) hashes commP with the Rust/WASM fr32
// multihash; the CLI (src/piece.ts) uses @web3-storage/data-segment. Both emit
// multihash 0x1011 and must produce the same PieceCID v2 for the same bytes —
// the browser-prepared manifest feeds `pdp-submit`, so a divergence makes the
// provider's recompute reject every browser-prepared piece (#29, lineage #19).
import * as WasmHasher from 'fr32-sha2-256-trunc254-padded-binary-tree-multihash'
import type { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import * as Digest from 'multiformats/hashes/digest'
import * as Link from 'multiformats/link'
import { buildCarUrl, CAR_ACCEPT } from '../src/gateway.ts'

// verified: fr32-sha2-256-trunc254-padded-binary-tree-multihash src/async.js
// digest — the multihash bytes come out via digestInto(bytes, 0, true).
function wasmPieceCid(write: (h: ReturnType<typeof WasmHasher.create>) => void): string {
  const hasher = WasmHasher.create()
  try {
    write(hasher)
    const out = new Uint8Array(hasher.multihashByteLength())
    hasher.digestInto(out, 0, true)
    return (Link.create(Raw.code, Digest.decode(out)) as CID).toString()
  } finally {
    hasher.free()
  }
}

function jsPieceCid(data: Uint8Array): string {
  const hasher = JsHasher.create()
  hasher.write(data)
  return (Link.create(Raw.code, hasher.digest()) as CID).toString()
}

test('WASM and JS piece hashers agree across padding edges', () => {
  // 0/1: degenerate; 64/65 and 127/128: fr32 254-bit padding boundaries;
  // 1 MiB + 3: multi-chunk write paths; the rest: a mid-size payload.
  const sizes = [0, 1, 64, 65, 127, 128, 1024, 1048579, 3500000]
  for (const size of sizes) {
    const data = new Uint8Array(size).map((_, i) => (i * 7) % 251)
    assert.equal(
      wasmPieceCid((h) => h.write(data)),
      jsPieceCid(data),
      `hashers diverged at ${size} bytes`
    )
  }
})

test('WASM hasher is chunk-size independent', () => {
  // Streaming hashers classically diverge on awkward write boundaries, not on
  // single-shot input. Feed the same payload in prime-sized chunks and compare
  // to the single write.
  const data = new Uint8Array(1048579).map((_, i) => (i * 31) % 251)
  const whole = wasmPieceCid((h) => h.write(data))
  for (const chunkSize of [1024, 997, 65537]) {
    const chunked = wasmPieceCid((h) => {
      for (let off = 0; off < data.length; off += chunkSize) {
        h.write(data.subarray(off, Math.min(off + chunkSize, data.length)))
      }
    })
    assert.equal(chunked, whole, `chunk size ${chunkSize} diverged from single-shot`)
  }
  assert.equal(whole, jsPieceCid(data))
})

// Live, like commp-piece-cid-regression.test.ts: the pinned PieceCIDs there are
// what the CLI computes and the provider verifies. The WASM hasher must land on
// the same values over the same gateway CARs. If the gateway is unreachable the
// assertions fail loudly rather than silently passing.
const GATEWAY = 'https://trustless-gateway.link'

const KNOWN = [
  {
    cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    pieceCid: 'bafkzcibdxzhqyefkufvnsmqlyrjyr3el6affnfo3l7ipfncjjzjl4hkaqhbaema3',
  },
  {
    cid: 'bafybeia2yt37rxkqu7ovw6ja3nf2aqatrzpcwh2tvl2kqbgeqcccn5evhy',
    pieceCid: 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa',
  },
]

test('WASM hasher reproduces the pinned PieceCIDs over the gateway CARs', async () => {
  for (const known of KNOWN) {
    const res = await fetch(buildCarUrl(GATEWAY, known.cid), { headers: { accept: CAR_ACCEPT } })
    assert.equal(res.ok, true, `gateway fetch failed for ${known.cid}: HTTP ${res.status}`)
    assert.ok(res.body != null)
    const hasher = WasmHasher.create()
    let pieceCid: string
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hasher.write(chunk)
      }
      const out = new Uint8Array(hasher.multihashByteLength())
      hasher.digestInto(out, 0, true)
      pieceCid = (Link.create(Raw.code, Digest.decode(out)) as CID).toString()
    } finally {
      hasher.free()
    }
    assert.equal(pieceCid, known.pieceCid, `WASM PieceCID drifted from pinned value for ${known.cid}`)
  }
})
