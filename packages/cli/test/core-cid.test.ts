import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalCid, toCanonicalCidV1 } from 'ipfs2foc-core'

const CID_V0 = 'QmdmQXB2mzChmMeKY47C43LxUdg1NDJ5MWcKMKxDu7RgQm'
const CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

test('toCanonicalCidV1 converts a CIDv0 to its canonical CIDv1', () => {
  const v1 = toCanonicalCidV1(CID_V0)
  assert.ok(v1 != null)
  assert.ok(v1.startsWith('bafybei'), `expected dag-pb CIDv1, got ${v1}`)
  // The converted form is itself canonical (round-trips through the strict check).
  assert.equal(canonicalCid(v1), v1)
  // CIDv0 is NOT accepted by the strict check (that's why we convert).
  assert.equal(canonicalCid(CID_V0), null)
})

test('toCanonicalCidV1 leaves an already-canonical CIDv1 unchanged', () => {
  assert.equal(toCanonicalCidV1(CID_V1), CID_V1)
})

test('toCanonicalCidV1 returns null for non-CID input', () => {
  assert.equal(toCanonicalCidV1('not-a-cid'), null)
  assert.equal(toCanonicalCidV1(''), null)
})
