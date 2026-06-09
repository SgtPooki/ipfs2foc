import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bigintJsonReplacer, findUnaccountedOnChain } from '../src/report.ts'

test('bigintJsonReplacer turns bigint values into decimal strings', () => {
  const obj = { current: 3757832n, last: 3757759n, nested: { finality: 30n }, list: [1n, 2n], normal: 'x' }
  const out = JSON.stringify(obj, bigintJsonReplacer)
  assert.equal(typeof out, 'string')
  // Round-trippable: JSON.parse gives us back the string forms.
  const parsed = JSON.parse(out)
  assert.equal(parsed.current, '3757832')
  assert.equal(parsed.nested.finality, '30')
  assert.deepEqual(parsed.list, ['1', '2'])
  assert.equal(parsed.normal, 'x')
})

test('findUnaccountedOnChain returns chain pieces that no local aggregate root matches', () => {
  const onChain = new Set(['bafA', 'bafB', 'bafC'])
  const localRoots = ['bafB']
  assert.deepEqual(findUnaccountedOnChain(onChain, localRoots), ['bafA', 'bafC'])
})

test('findUnaccountedOnChain returns empty when every chain piece has a local match', () => {
  const onChain = new Set(['bafA', 'bafB'])
  const localRoots = ['bafA', 'bafB', 'bafExtra']
  assert.deepEqual(findUnaccountedOnChain(onChain, localRoots), [])
})

test('findUnaccountedOnChain returns every chain piece when local has none', () => {
  const onChain = new Set(['bafA', 'bafB', 'bafC'])
  assert.deepEqual(findUnaccountedOnChain(onChain, []).sort(), ['bafA', 'bafB', 'bafC'])
})
