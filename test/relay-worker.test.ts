import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handle, type RelayEnv } from '../relay/handler.ts'
import { buildCarUrl, relayPullUrl } from '../src/car-url.ts'

// Real values from the in-browser commP spike: a canonical CIDv1 source and the
// PieceCID v2 computed over its CAR. CIDv0 sample is a well-known example CID.
const SOURCE_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const PIECE_CID = 'bafkzcibdxzhqyefkufvnsmqlyrjyr3el6affnfo3l7ipfncjjzjl4hkaqhbaema3'
const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
const TRUSTED = 'https://trustless-gateway.link'
const HOST = 'trustless-gateway.link'

function get(path: string, env: RelayEnv = {}, method = 'GET'): Response {
  // Exercise the pure routing handler directly. The Worker entry's per-IP rate
  // limit (a Cloudflare binding) is verified live, not here.
  return handle(new Request(`https://relay.example${path}`, { method }), env)
}

/** Build the stateless pull path the dApp would hand the provider. */
function pullPath(host: string, cid: string, pcid = PIECE_CID): string {
  return `/r/${host}/${cid}/piece/${pcid}`
}

test('valid pull 302s to the canonical gateway CAR URL', () => {
  const res = get(pullPath(HOST, SOURCE_CID))
  assert.equal(res.status, 302)
  // The 302 target must be byte-for-byte the URL the migrator committed over.
  // Asserting against buildCarUrl (the shared source) is the anti-drift guard.
  assert.equal(res.headers.get('location'), buildCarUrl(TRUSTED, SOURCE_CID))
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

test('HEAD on the pull path also 302s', () => {
  const res = get(pullPath(HOST, SOURCE_CID), {}, 'HEAD')
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), buildCarUrl(TRUSTED, SOURCE_CID))
})

test('userinfo (@) smuggling is rejected — not an exact allowlist member', () => {
  // `evil.com@trustless-gateway.link`: the stateful relay used to ACCEPT this
  // (URL.hostname resolves to the trusted host). Exact-membership matching
  // rejects it, and crucially the relay never emits the raw segment.
  assert.equal(get(pullPath('evil.com@trustless-gateway.link', SOURCE_CID)).status, 403)
})

test('port-bearing host is rejected', () => {
  assert.equal(get(pullPath('trustless-gateway.link:8443', SOURCE_CID)).status, 403)
})

test('look-alike subdomain and arbitrary host are rejected', () => {
  assert.equal(get(pullPath('trustless-gateway.link.evil.com', SOURCE_CID)).status, 403)
  assert.equal(get(pullPath('evil.example.com', SOURCE_CID)).status, 403)
})

test('percent-encoding anywhere in the path is rejected (no decode-then-reinterpret)', () => {
  // `trustless-gateway%2elink` would decode to the trusted host; reject outright.
  assert.equal(get(pullPath('trustless-gateway%2elink', SOURCE_CID)).status, 404)
  assert.equal(get(pullPath(HOST, `${SOURCE_CID}%2f..`)).status, 404)
})

test('non-canonical CIDs are rejected (CIDv0, junk)', () => {
  // CIDv0 (base58, version 0) — different bytes than the committed CIDv1 form.
  assert.equal(get(pullPath(HOST, CID_V0)).status, 404)
  // Uppercased base32 v1 does not round-trip to itself.
  assert.equal(get(pullPath(HOST, SOURCE_CID.toUpperCase())).status, 404)
  assert.equal(get(pullPath(HOST, 'not-a-cid')).status, 404)
})

test('extra allowlisted host via env is accepted', () => {
  const env: RelayEnv = { ALLOWED_GATEWAY_HOSTS: 'ipfs.example.org' }
  const res = get(pullPath('ipfs.example.org', SOURCE_CID), env)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), buildCarUrl('https://ipfs.example.org', SOURCE_CID))
})

test('strict path shape: wrong arity, trailing slash, missing /piece', () => {
  assert.equal(get(`/r/${HOST}/${SOURCE_CID}/piece/${PIECE_CID}/`).status, 404) // trailing slash
  assert.equal(get(`/r/${HOST}/${SOURCE_CID}/${PIECE_CID}`).status, 404) // no /piece segment
  assert.equal(get(`/r/${HOST}/piece/${PIECE_CID}`).status, 404) // missing cid
  assert.equal(get(`/r/${HOST}/${SOURCE_CID}/piece/${PIECE_CID}/extra`).status, 404) // extra segment
})

test('overlong path is rejected before parsing', () => {
  assert.equal(get(`/r/${HOST}/${'a'.repeat(600)}/piece/${PIECE_CID}`).status, 404)
})

test('submit-built relay URL parses back to the exact committed gateway CAR (build↔parse loop)', () => {
  // What the submit side emits (relayPullUrl) must, when the relay parses it,
  // 302 to the identical buildCarUrl the piece was committed over. This closes
  // the loop between src/submit-pdp.ts and relay/handler.ts.
  const built = relayPullUrl('https://relay.example', HOST, SOURCE_CID, PIECE_CID)
  const path = new URL(built).pathname
  const res = handle(new Request(`https://relay.example${path}`), {})
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), buildCarUrl(TRUSTED, SOURCE_CID))
})

test('method and routing guards', () => {
  assert.equal(get(pullPath(HOST, SOURCE_CID), {}, 'POST').status, 405)
  assert.equal(get('/healthz').status, 200)
  assert.equal(get('/healthz', {}, 'HEAD').status, 200)
  assert.equal(get('/healthz', {}, 'POST').status, 405)
  assert.equal(get('/').status, 404)
  assert.equal(get('/nope').status, 404)
})
