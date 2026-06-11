/**
 * Unit coverage for the shared cids.txt collector (ipfs2foc-core/cid-list).
 *
 * The collector backs the console's file intake (#50) and mirrors the shape
 * the CLI's --cids reads: one CID per line, blank lines and `#` comments
 * skipped. The properties locked here: input spelling preserved, dedup on the
 * canonical CIDv1 (so a CIDv0 and its v1 re-encoding count once), invalid
 * lines counted with capped 1-based samples.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createCidCollector, INVALID_SAMPLE_CAP } from 'ipfs2foc-core/cid-list'
import { CID } from 'multiformats/cid'

const V0 = 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR'
const V1 = CID.parse(V0).toV1().toString()
const OTHER = 'bafybeia2yt37rxkqu7ovw6ja3nf2aqatrzpcwh2tvl2kqbgeqcccn5evhy'

test('skips blanks and comments, trims, preserves input form', () => {
  const c = createCidCollector()
  for (const line of ['', '# inventory', `  ${V0}  `, OTHER, '   ']) c.line(line)
  assert.deepEqual(c.result(), { cids: [V0, OTHER], invalidSamples: [], invalidCount: 0 })
})

test('dedupes across CID versions on the canonical v1 form', () => {
  const c = createCidCollector()
  for (const line of [V0, V1, V0, OTHER, OTHER]) c.line(line)
  assert.deepEqual(c.result().cids, [V0, OTHER])
})

test('counts invalid lines and caps the samples with 1-based line numbers', () => {
  const c = createCidCollector()
  c.line('# header')
  for (let i = 0; i < INVALID_SAMPLE_CAP + 3; i++) c.line(`not-a-cid-${i}`)
  c.line(OTHER)
  const r = c.result()
  assert.equal(r.invalidCount, INVALID_SAMPLE_CAP + 3)
  assert.equal(r.invalidSamples.length, INVALID_SAMPLE_CAP)
  assert.deepEqual(r.invalidSamples[0], { line: 2, text: 'not-a-cid-0' })
  assert.deepEqual(r.cids, [OTHER])
})

test('truncates pathological sample text', () => {
  const c = createCidCollector()
  c.line(`zz${'x'.repeat(500)}`)
  const r = c.result()
  assert.equal(r.invalidCount, 1)
  assert.equal(r.invalidSamples[0].text.length, 64)
})
