/**
 * Redirect server: maps `GET /piece/{pcidv2}` to a 302 pointing at the original
 * gateway CAR for that piece.
 *
 * This is the indirection that lets a storage provider's PDP pull — which only
 * admits source URLs shaped `/piece/{pieceCidV2}` — fetch a piece whose bytes
 * actually live at an IPFS gateway (`/ipfs/{cid}?format=car`). The provider's
 * pull client follows the cross-origin redirect and downloads the CAR straight
 * from the gateway, so this server relays no payload: it answers only the 302.
 *
 * Run it behind any public HTTPS ingress (Tailscale Funnel, a tunnel, a VPS).
 * The public base URL is passed to `submit` as the pull source base; this server
 * only needs to be reachable by the provider.
 */

import { createServer } from 'node:http'
import type { MigrationDB } from './db.ts'
import { log } from './util.ts'

const PIECE_PATH = /^\/piece\/([^/]+)$/

export function startRedirectServer(db: MigrationDB, port: number): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    // Health check for ingress probes.
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }

    const match = PIECE_PATH.exec(url.pathname)
    if (req.method !== 'GET' || match == null) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }

    const pieceCid = match[1]
    const target = db.pieceUrlByPieceCid(pieceCid)
    if (target == null) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('unknown piece')
      return
    }

    // 302 to the gateway CAR. no-store keeps intermediaries from pinning the
    // redirect, so each provider pull resolves freshly.
    res.writeHead(302, { location: target, 'cache-control': 'no-store' })
    res.end()
  })

  server.listen(port, () => {
    log(`foc-migrate redirect server on http://localhost:${port} (GET /piece/{pieceCidV2} -> 302 gateway CAR)`)
    log('Front this with a public HTTPS ingress (e.g. `tailscale funnel ' + port + '`) and pass that base to `submit --source-base`.')
  })
}
