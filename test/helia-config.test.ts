import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildLibp2pConfig, stopHeliaFallback } from '../src/helia-fallback.ts'
import { fallbackFetch, stopVerifiedFetch } from '../src/verified-fetch.ts'

// Regression guard for #18. The bitswap fallback node is assembled with a
// hand-built, outbound-only libp2p (TCP + WebSockets) rather than libp2p's
// browser defaults, which pull @libp2p/webrtc → node-datachannel. The native
// binding now builds under pnpm, but the migrator only dials out, so WebRTC
// stays out of the dialed transports. These tests fail the moment a WebRTC
// transport or a listen address reappears in the config.

test('libp2p config builds without a WebRTC transport', async () => {
  const cfg = await buildLibp2pConfig()
  assert.ok(Array.isArray(cfg.transports) && cfg.transports.length === 2)
})

test('libp2p config has no WebRTC transport', async () => {
  const cfg = await buildLibp2pConfig()
  const names = (cfg.transports ?? []).map((t: unknown) => {
    const fn = t as { [Symbol.toStringTag]?: string; toString?: () => string }
    return `${fn[Symbol.toStringTag] ?? ''} ${fn.toString?.() ?? ''}`
  })
  for (const n of names) {
    assert.equal(/webrtc/i.test(n), false, `unexpected WebRTC transport: ${n}`)
  }
})

test('libp2p config has no listen addresses (outbound-only, no webrtc-direct)', async () => {
  const cfg = await buildLibp2pConfig()
  assert.deepEqual(cfg.addresses?.listen ?? [], [])
})

test('bitswap-enabled verified-fetch node starts and stops without the node-datachannel crash', async () => {
  // The strongest #18 guard: the whole fallback path stands up and tears down.
  // Building the node imports @helia/verified-fetch and the bitswap broker; a
  // WebRTC import creeping back in would crash here.
  const fetch = await fallbackFetch(['https://trustless-gateway.link'])
  assert.equal(typeof fetch, 'function')
  await stopVerifiedFetch()
  // stopHeliaFallback is the legacy entry point; it must be safe after teardown.
  await stopHeliaFallback()
})
