// The run manifest type, builder, and validator live in `ipfs2foc-core/manifest`
// (the single source of truth shared with the CLI). This module re-exports them
// and adds the browser-only download helper.
export { buildManifest, MANIFEST_VERSION, type ManifestPiece, type RunManifest } from 'ipfs2foc-core/manifest'

import type { RunManifest } from 'ipfs2foc-core/manifest'

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
