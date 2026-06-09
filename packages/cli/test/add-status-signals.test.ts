import assert from 'node:assert/strict'
import { test } from 'node:test'
import { interpretAddStatus } from '../src/pdp.ts'

// addStatus carries three independent signals; success requires all three.
// See skills/addstatus-three-signals.md.

test('404 means the tx is not yet observed — keep polling', () => {
  assert.deepEqual(interpretAddStatus(404, null), { done: false, ok: false })
})

test('confirmed + addMessageOk + piecesAdded is the only success', () => {
  const r = interpretAddStatus(200, {
    txStatus: 'confirmed',
    addMessageOk: true,
    piecesAdded: true,
    confirmedPieceIds: [7],
  })
  assert.equal(r.done, true)
  assert.equal(r.ok, true)
  assert.deepEqual(r.confirmedPieceIds, [7])
})

test('confirmed but reverted (addMessageOk false) is a terminal failure', () => {
  const r = interpretAddStatus(200, { txStatus: 'confirmed', addMessageOk: false, piecesAdded: false })
  assert.equal(r.done, true)
  assert.equal(r.ok, false)
  assert.match(r.reason ?? '', /reverted/)
})

test('confirmed but bookkeeping lagging (addMessageOk null) keeps polling', () => {
  const r = interpretAddStatus(200, { txStatus: 'confirmed', addMessageOk: null, piecesAdded: false })
  assert.deepEqual(r, { done: false, ok: false })
})

test('confirmed + addMessageOk true but piecesAdded false keeps polling', () => {
  const r = interpretAddStatus(200, { txStatus: 'confirmed', addMessageOk: true, piecesAdded: false })
  assert.deepEqual(r, { done: false, ok: false })
})

test('txStatus failed is terminal and not ok', () => {
  const r = interpretAddStatus(200, { txStatus: 'failed' })
  assert.equal(r.done, true)
  assert.equal(r.ok, false)
  assert.match(r.reason ?? '', /failed on chain/)
})

test('txStatus pending keeps polling', () => {
  assert.deepEqual(interpretAddStatus(200, { txStatus: 'pending' }), { done: false, ok: false })
})

test('an unknown/absent txStatus keeps polling rather than declaring success', () => {
  assert.deepEqual(interpretAddStatus(200, {}), { done: false, ok: false })
  assert.deepEqual(interpretAddStatus(200, { txStatus: 'whatever' }), { done: false, ok: false })
})
