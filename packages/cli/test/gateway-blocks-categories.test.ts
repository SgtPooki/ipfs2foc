import assert from 'node:assert/strict'
import { test } from 'node:test'
import { categorizeBlockError } from '../src/gateway-blocks.ts'

// The block-verified prepare path retrieves the DAG over a streaming CAR
// request and gap-fills missing blocks with single `?format=raw` requests
// (`ipfs2foc-core/car-stream-source`). A failed request surfaces as a plain
// Error whose message carries the cause; these pin the mapping onto the
// failure categories that drive retry, the IPFS fallback, and reporting.
// `categorizeBlockError` also walks nested AggregateError chains, since a
// native fetch failure can arrive wrapped.

test('a 5xx in the request message maps to source_gateway_5xx', () => {
  assert.equal(
    categorizeBlockError(new Error('gateway request for https://gw/ipfs/x received 504 Gateway Timeout')),
    'source_gateway_5xx'
  )
})

test('a 429 maps to source_gateway_429', () => {
  assert.equal(
    categorizeBlockError(new Error('gateway request for https://gw/ipfs/x received 429 Too Many Requests')),
    'source_gateway_429'
  )
})

test('an aborted request maps to source_gateway_timeout', () => {
  assert.equal(categorizeBlockError(new Error('This operation was aborted')), 'source_gateway_timeout')
})

test('a dropped connection maps to source_gateway_network', () => {
  assert.equal(categorizeBlockError(new Error('fetch failed')), 'source_gateway_network')
})

test('a hash mismatch maps to car_root_mismatch (bad bytes from this gateway)', () => {
  assert.equal(
    categorizeBlockError(new Error('block x from gateway https://gw did not match multihash from CID')),
    'car_root_mismatch'
  )
})

test('a nested AggregateError chain is still classified by its inner message', () => {
  const nested = new AggregateError([new AggregateError([new Error('fetch failed')])])
  assert.equal(categorizeBlockError(nested), 'source_gateway_network')
})

test('a 404 is not retriable: other', () => {
  assert.equal(categorizeBlockError(new Error('gateway request for https://gw/ipfs/x received 404 Not Found')), 'other')
})

test('an unrecognized failure maps to other', () => {
  assert.equal(categorizeBlockError(new Error('something else entirely')), 'other')
})
