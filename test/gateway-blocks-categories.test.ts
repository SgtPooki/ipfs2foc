import assert from 'node:assert/strict'
import { test } from 'node:test'
import { categorizeBlockError } from '../src/gateway-blocks.ts'

// The block-verified prepare path surfaces broker failures as message text
// inside (possibly nested) AggregateError chains — helia's LoadBlockFailedError
// wraps the broker's AggregateError, which wraps the per-gateway error. These
// pin the mapping onto the failure categories that drive retry, the IPFS
// fallback, and reporting.

/** Mirror the helia error nesting: LoadBlockFailedError(AggregateError(inner)). */
function nested(message: string): AggregateError {
  return new AggregateError([new AggregateError([new Error(message)], 'Unable to fetch raw block from any gateway')])
}

test('a 5xx folded into the broker message maps to source_gateway_5xx', () => {
  assert.equal(
    categorizeBlockError(nested('Unable to fetch raw block for CID x - received 504 Gateway Timeout')),
    'source_gateway_5xx'
  )
})

test('a 429 maps to source_gateway_429', () => {
  assert.equal(
    categorizeBlockError(nested('Unable to fetch raw block for CID x - received 429 Too Many Requests')),
    'source_gateway_429'
  )
})

test('the session post-eviction message is the cold-backend case (5xx family)', () => {
  assert.equal(
    categorizeBlockError(
      nested('Found 0 of 1 trustless-gateway-session providers for x, 0 in session after evictions')
    ),
    'source_gateway_5xx'
  )
})

test('an aborted fetch maps to source_gateway_timeout', () => {
  assert.equal(
    categorizeBlockError(nested('Fetching raw block for CID x from gateway y was aborted')),
    'source_gateway_timeout'
  )
})

test('a dropped connection maps to source_gateway_network', () => {
  assert.equal(
    categorizeBlockError(nested('Unable to fetch raw block for CID x - fetch failed')),
    'source_gateway_network'
  )
})

test('a hash mismatch maps to car_root_mismatch (bad bytes from this gateway)', () => {
  assert.equal(
    categorizeBlockError(nested('Hash of downloaded block did not match multihash from passed CID')),
    'car_root_mismatch'
  )
})

test('a 404 is not retriable: other', () => {
  assert.equal(categorizeBlockError(nested('Unable to fetch raw block for CID x - received 404 Not Found')), 'other')
})

test('an unrecognized failure maps to other', () => {
  assert.equal(categorizeBlockError(new Error('something else entirely')), 'other')
})
