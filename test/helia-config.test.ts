import { test, skip } from 'node:test'
import assert from 'node:assert/strict'
import { buildLibp2pConfig } from '../src/helia-fallback.ts'

// These tests verify the #10 WebRTC-removal intent, but they cannot pass until
// #18 is fixed: `import('helia')` itself throws because helia's module graph
// statically pulls @libp2p/webrtc → node-datachannel → a native .node binary
// that is not prebuilt for Node 26. The runtime filter in buildLibp2pConfig
// runs too late to prevent the crash. Skip until the import-time issue is
// resolved (construct libp2p from individual @libp2p/* packages, bypassing
// helia's libp2pDefaults bundle).
// See: https://github.com/SgtPooki/foc-migrate/issues/18

skip('libp2p config has no WebRTC transport — skipped: #18 node-datachannel import-time crash', async () => {
  const cfg = await buildLibp2pConfig()
  const names = (cfg.transports ?? []).map((t: unknown) => {
    const fn = t as { name?: string; toString?: () => string }
    return (fn.name ?? '') + ' ' + (fn.toString?.() ?? '')
  })
  for (const n of names) {
    assert.equal(/WebRTC/i.test(n), false, `unexpected WebRTC transport: ${n}`)
  }
})

skip('libp2p config has no webrtc listen addresses — skipped: #18 node-datachannel import-time crash', async () => {
  const cfg = await buildLibp2pConfig()
  const listens = cfg.addresses?.listen ?? []
  for (const addr of listens) {
    assert.equal(/webrtc/i.test(addr), false, `unexpected webrtc listen address: ${addr}`)
  }
})

skip('libp2p config keeps TCP transport for outbound dial — skipped: #18 node-datachannel import-time crash', async () => {
  const cfg = await buildLibp2pConfig()
  const names = (cfg.transports ?? []).map((t: unknown) => {
    const fn = t as { name?: string; toString?: () => string }
    return (fn.name ?? '') + ' ' + (fn.toString?.() ?? '')
  })
  const hasTcp = names.some((n: string) => /TCP/i.test(n))
  assert.ok(hasTcp, 'expected a TCP transport to remain for outbound dial')
})
