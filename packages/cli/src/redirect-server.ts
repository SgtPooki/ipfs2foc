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
 * Run it behind any public HTTPS ingress (Tailscale Funnel, Cloudflared, a
 * VPS). The public base URL is passed to `submit` as the pull source base;
 * this server only needs to be reachable by the provider.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { MigrationDB } from './db.ts'
import { CAR_ACCEPT } from './gateway.ts'
import { log } from './util.ts'

const PIECE_PATH = /^\/piece\/([^/]+)$/

/**
 * Shared request handler. Used by the plain Funnel/VPS path here and by any
 * other ingress that exposes its own HTTPS surface (e.g. cloudflared).
 *
 * Two dispatch paths:
 *   - The piece commitment matches a packed multi-asset sub-piece: stream the
 *     assembled CAR from `--car-store` with `Content-Length` set. Plain 200
 *     OK; no Range header; no auth. Curio's pull client expects this shape
 *     (`pdp/handlers_pull.go`).
 *   - The piece commitment matches a single source CID: 302 to the gateway
 *     CAR (the path the migrator has always taken). The provider's pull
 *     follows the cross-origin redirect and downloads from the gateway
 *     directly.
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

    // One lookup. Every piece commitment in the schema is a sub-piece —
    // passthrough sub-pieces carry the gateway URL, assembled sub-pieces
    // carry the CAR file path. The branch picks the response shape.
    const subPiece = db.subPieceByCid(pieceCid)
    if (subPiece == null || subPiece.status !== 'built') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end(subPiece == null ? 'unknown piece' : 'sub-piece not built')
      return
    }

    if (subPiece.carPath != null) {
      serveAssembledCar(res, subPiece.carPath, subPiece.assembledCarLength).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        log(`serve ${pieceCid}: ${message}`)
      })
      return
    }

    if (subPiece.url != null) {
      // 302 to the upstream gateway CAR. no-store keeps intermediaries from
      // pinning the redirect, so each provider pull resolves freshly.
      res.writeHead(302, { location: subPiece.url, 'cache-control': 'no-store' })
      res.end()
      return
    }

    // Should be unreachable given the CHECK ((car_path IS NULL) != (url IS NULL)).
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('sub-piece has neither car_path nor url')
  }
}

/**
 * Stream the assembled CAR file with the headers the provider's pull expects:
 * `Content-Length` set up-front (used as `resp.ContentLength > group.PieceRawSize`
 * in `task_pull_piece.go:1002`), plain CAR content type, no `Accept-Ranges`.
 * `stat` is used to confirm the on-disk length matches the planned length —
 * otherwise the pull would proceed against a truncated file.
 */
async function serveAssembledCar(res: ServerResponse, filePath: string, expectedLength: number): Promise<void> {
  const stats = await stat(filePath).catch(() => null)
  if (stats == null) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('assembled car missing')
    return
  }
  if (stats.size !== expectedLength) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(`assembled car length drift: expected ${expectedLength}, on disk ${stats.size}`)
    return
  }
  res.writeHead(200, {
    'content-type': CAR_ACCEPT,
    'content-length': String(expectedLength),
    'cache-control': 'no-store',
  })
  const body = createReadStream(filePath)
  body.on('error', () => {
    if (!res.writableEnded) res.end()
  })
  body.pipe(res)
}

export function startRedirectServer(db: MigrationDB, port: number): void {
  const server = createServer(makeRedirectHandler(db))

  server.listen(port, () => {
    log(`ipfs2foc redirect server on http://localhost:${port} (GET /piece/{pieceCidV2} -> 302 gateway CAR)`)
    log(
      `Front this with a public HTTPS ingress (e.g. \`tailscale funnel ${port}\`, a Cloudflare tunnel, or a VPS reverse proxy) and pass that base to \`pdp-submit --source-base\`. See docs/ingress.md.`
    )
  })
}
