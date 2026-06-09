import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeAccounting } from '../src/report.ts'

// computeAccounting must conserve by construction and surface — not clamp away —
// any inconsistency (M2), while counting committed CIDs distinctly (M3).

test('clean run: everything committed conserves with no discrepancies', () => {
  const a = computeAccounting(
    { pending: 0, processing: 0, done: 48, failed: 0, oversized: 0, total: 48 },
    { inPieces: 48, total: 48 }
  )
  assert.equal(a.committed, 48)
  assert.equal(a.pendingNotCommitted, 0)
  assert.equal(a.unaccounted, 0)
  assert.deepEqual(a.discrepancies, [])
})

test('partially committed: the rest is pending, not unaccounted', () => {
  const a = computeAccounting(
    { pending: 10, processing: 0, done: 40, failed: 0, oversized: 0, total: 50 },
    { inPieces: 30, total: 30 }
  )
  assert.equal(a.committed, 30)
  assert.equal(a.pendingNotCommitted, 20) // (10 pending + 40 done) - 30 committed
  assert.equal(a.unaccounted, 0)
  assert.deepEqual(a.discrepancies, [])
})

test('failed and oversized are accounted without discrepancy', () => {
  const a = computeAccounting(
    { pending: 0, processing: 0, done: 5, failed: 3, oversized: 2, total: 10 },
    { inPieces: 5, total: 5 }
  )
  assert.equal(a.committed, 5)
  assert.equal(a.pendingNotCommitted, 0)
  assert.equal(a.unaccounted, 0)
  assert.deepEqual(a.discrepancies, [])
})

test('a CID committed on chain but absent locally is surfaced, not hidden', () => {
  const a = computeAccounting(
    { pending: 0, processing: 0, done: 5, failed: 0, oversized: 0, total: 5 },
    { inPieces: 5, total: 6 } // 6 distinct on chain, only 5 present locally
  )
  assert.equal(a.discrepancies.length >= 1, true)
  assert.match(a.discrepancies.join('\n'), /absent from the\s+local pieces table/)
})

test('a committed count that exceeds local CIDs is surfaced as non-conserving', () => {
  // Pathological: committed (in pieces) larger than done+pending — clamps for
  // display but must report the inconsistency.
  const a = computeAccounting(
    { pending: 0, processing: 0, done: 3, failed: 0, oversized: 0, total: 3 },
    { inPieces: 5, total: 5 }
  )
  assert.equal(a.pendingNotCommitted, 0) // clamped
  assert.match(a.discrepancies.join('\n'), /does not conserve/)
})
