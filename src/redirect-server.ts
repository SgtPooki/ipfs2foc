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
 * Ingress: front this with any public HTTPS path. Two ingress paths ship in
 * this repo:
 *   - `--ingress funnel` (default): user runs `tailscale funnel <port>`.
 *   - `--ingress libp2p`: a js-libp2p node with autotls obtains a
 *     `*.libp2p.direct` cert and shares its WSS listener with the redirect
 *     handler on one TCP port. See `redirect-server-libp2p.ts`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { MigrationDB } from './db.ts'
import { log } from './util.ts'

const PIECE_PATH = /^\/piece\/([^/]+)$/

/**
 * Shared request handler. Used by both the Funnel/stdlib HTTP server here and
 * the libp2p ingress that monkey-patches itself onto the @libp2p/websockets
 * listener's `https.Server`.
 */
export function makeRedirectHandler(db: MigrationDB): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
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
  }
}

export function startRedirectServer(db: MigrationDB, port: number): void {
  const server = createServer(makeRedirectHandler(db))

  server.listen(port, () => {
    log(`foc-migrate redirect server on http://localhost:${port} (GET /piece/{pieceCidV2} -> 302 gateway CAR)`)
    log('Front this with a public HTTPS ingress (e.g. `tailscale funnel ' + port + '`) and pass that base to `pdp-submit --source-base`.')
  })
}
