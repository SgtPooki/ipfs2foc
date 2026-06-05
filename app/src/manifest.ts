// The run manifest: the portable artifact the prepare step produces. It carries
// what the submit step needs — the per-piece pull URLs and the commitments — and
// is consumable by the CLI `pdp-submit --source-relay` or an in-browser signing
// flow.
import type { PieceResult } from './commp.ts'

export interface RunManifest {
  version: 1
  tool: 'ipfs2foc-app'
  createdAt: string
  network: string
  relayBase: string
  gateway: string
  pieces: Array<{
    cid: string
    pieceCid: string
    rawSize: number
    sourceUrl: string
  }>
}

export function buildManifest(
  results: PieceResult[],
  opts: { network: string; relayBase: string; gateway: string; now: string }
): RunManifest {
  return {
    version: 1,
    tool: 'ipfs2foc-app',
    createdAt: opts.now,
    network: opts.network,
    relayBase: opts.relayBase,
    gateway: opts.gateway,
    pieces: results.map((r) => ({
      cid: r.cid,
      pieceCid: r.pieceCid,
      rawSize: r.rawSize,
      sourceUrl: r.sourceUrl,
    })),
  }
}

export function downloadManifest(manifest: RunManifest): void {
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `ipfs2foc-manifest-${manifest.createdAt.replace(/[:.]/g, '-')}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
