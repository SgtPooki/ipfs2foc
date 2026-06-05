import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { buildCarUrl, CAR_ACCEPT, fetchCar } from '../src/gateway.ts'
import { fetchAndComputePiece } from '../src/piece.ts'

// HARD GUARDRAIL (#19): the migrator's PieceCID must equal what the storage
// provider recomputes from the bytes it pulls. The provider is 302'd to the
// pinned gateway URL (`buildCarUrl`); the migrator computes its PieceCID over
// the same direct gateway CAR. With the passthrough commP path fetching that
// CAR directly, the migrator's bytes ARE the provider's bytes — byte-safe by
// construction. This regression test pins the known-good CAR size/sha256 and the
// resulting PieceCID for two real CIDs so a gateway framing change or a
// piece-hasher regression is caught.
//
// Live: it fetches real CARs from a public trustless gateway, the same way
// `helia-config.test.ts` stands up a real node. If the gateway is unreachable
// the assertions fail loudly rather than silently passing.

const GATEWAY = 'https://trustless-gateway.link'

interface KnownCar {
  cid: string
  /** sha256 + size of the direct `?format=car…` gateway CAR (pinned). */
  sha256: string
  bytes: number
  /** PieceCID v2 computed over that CAR. */
  pieceCid: string
}

const KNOWN: KnownCar[] = [
  {
    cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    sha256: '89795ad1b0d2a9a712e67989122929c56bfa00ef3c1e063aca86d19a4025f589',
    bytes: 119874,
    pieceCid: 'bafkzcibdxzhqyefkufvnsmqlyrjyr3el6affnfo3l7ipfncjjzjl4hkaqhbaema3',
  },
  {
    cid: 'bafybeia2yt37rxkqu7ovw6ja3nf2aqatrzpcwh2tvl2kqbgeqcccn5evhy',
    sha256: '57aec52dbfc093616afb482a8eec4c877fba1bbf209e4b115764c131a88a0cbc',
    bytes: 5010728,
    pieceCid: 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa',
  },
]

async function hashStream(body: ReadableStream<Uint8Array>): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { sha256: hash.digest('hex'), bytes }
}

test('direct gateway CAR has the pinned size/sha256 and PieceCID', async () => {
  for (const known of KNOWN) {
    // 1. The pinned gateway URL the provider is 302'd to streams the known CAR.
    const direct = await fetch(buildCarUrl(GATEWAY, known.cid), { headers: { accept: CAR_ACCEPT } })
    assert.equal(direct.ok, true, `direct gateway fetch failed for ${known.cid}: HTTP ${direct.status}`)
    assert.ok(direct.body != null)
    const directDigest = await hashStream(direct.body)
    assert.equal(directDigest.sha256, known.sha256, `pinned direct CAR sha256 drifted for ${known.cid}`)
    assert.equal(directDigest.bytes, known.bytes)

    // 2. `fetchCar` (the commP-input retrieval) streams the same pinned bytes.
    const viaFetchCar = await fetchCar(GATEWAY, known.cid)
    assert.equal(viaFetchCar.url, buildCarUrl(GATEWAY, known.cid))
    const fetchCarDigest = await hashStream(viaFetchCar.body)
    assert.equal(fetchCarDigest.sha256, known.sha256)
    assert.equal(fetchCarDigest.bytes, known.bytes)

    // 3. The PieceCID the migrator submits matches the pinned value.
    const piece = await fetchAndComputePiece(known.cid, [GATEWAY])
    assert.equal(piece.pieceCid, known.pieceCid, `PieceCID drifted for ${known.cid}`)
    assert.equal(piece.rawSize, known.bytes)
    assert.equal(piece.memberSha256, known.sha256)
    assert.equal(piece.source, 'gateway')
    assert.equal(piece.url, buildCarUrl(GATEWAY, known.cid))
  }
})
