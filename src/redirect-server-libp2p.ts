/**
 * libp2p + autotls ingress for the redirect server.
 *
 * Brings up a js-libp2p node with @libp2p/websockets + @ipshipyard/libp2p-auto-tls,
 * which:
 *   1. Listens on a TCP port (UPnP-mapped via @libp2p/upnp-nat when possible).
 *   2. Registers with p2p-forge and obtains a Let's Encrypt cert for
 *      `*.<peerID>.libp2p.direct`.
 *   3. Creates an internal `https.Server` (the WSS listener) using that cert,
 *      with one socket fanning out to plain HTTP, HTTPS, and WS upgrades via
 *      an httpolyglot first-byte sniff.
 *
 * The transport's default `request` handler returns HTTP 400. We swap it for
 * the foc-migrate 302 redirect handler after `certificate:provision` so a
 * stock `net/http` client dialing `https://<encoded-ip>.<peerID>.libp2p.direct[:port]/piece/x`
 * receives a 302 to the gateway CAR. We re-swap on `certificate:renew`
 * because the transport rebuilds the `https.Server` on renewal.
 *
 * One TCP port, one cert. Curio's stdlib HTTP client and p2p-forge's libp2p
 * reachability probe both reach the same listener.
 *
 * Prerequisites for this ingress to work:
 *   - One public TCP port reachable from the internet, via UPnP, manual port
 *     forward, or public IPv6 pinhole. CGNAT v4 without IPv6 is a no-go.
 *   - ~30 s to ~2 min cold start for the first ACME issuance.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Server as HttpsServer } from 'node:https'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { autoTLS } from '@ipshipyard/libp2p-auto-tls'
import { autoNAT } from '@libp2p/autonat'
import { http } from '@libp2p/http'
import { identify } from '@libp2p/identify'
import { keychain } from '@libp2p/keychain'
import { uPnPNAT } from '@libp2p/upnp-nat'
import { webSockets } from '@libp2p/websockets'
import { createLibp2p, type Libp2p } from 'libp2p'
import type { MigrationDB } from './db.ts'
import { makeRedirectHandler } from './redirect-server.ts'
import { log } from './util.ts'

interface Options {
  /**
   * TCP port the libp2p node listens on. Defaults to 0 (OS-assigned).
   * Bind 443 (with `cap_net_bind_service` or root) for the cleanest URL.
   */
  port?: number
  /**
   * Milliseconds to wait for the first cert before logging "still waiting"
   * status. Cold-start budget. Defaults to 5 minutes.
   */
  certTimeoutMs?: number
}

/**
 * Find the @libp2p/websockets transport listener that exposes an internal
 * `https.Server`. The class is `WebSocketListener` and the field is `https`,
 * private but reachable through an `any` cast since we own the runtime.
 */
function findWssListener(node: Libp2p): { https: HttpsServer } | undefined {
  // The transportManager's listeners are exposed via the components bag.
  // No public API yet — this is the runtime hack the upstream PR will obsolete.
  const components = (node as unknown as { components: { transportManager: { getListeners: () => unknown[] } } }).components
  const listeners = components.transportManager.getListeners()
  for (const l of listeners) {
    const candidate = l as { https?: HttpsServer }
    if (candidate.https != null && typeof candidate.https.setSecureContext === 'function') {
      return candidate as { https: HttpsServer }
    }
  }
  return undefined
}

/**
 * Swap the WSS listener's `request` handler for the redirect handler. The WS
 * `upgrade` listener stays attached, so libp2p WSS dials (including
 * p2p-forge's reachability probe) keep working on the same port.
 */
function patchListener(node: Libp2p, handler: (req: IncomingMessage, res: ServerResponse) => void): boolean {
  const listener = findWssListener(node)
  if (listener == null) {
    return false
  }
  listener.https.removeAllListeners('request')
  listener.https.addListener('request', handler)
  return true
}

/**
 * Compute the public base URL Curio will dial. autotls advertises a multiaddr
 * shaped `/ip4/X/tcp/PORT/tls/sni/<encoded-ip>.<peerID>.libp2p.direct/ws/p2p/<peerID>`;
 * we strip the libp2p frame and keep `https://<sni>[:<port>]`.
 */
function deriveBaseUrl(node: Libp2p): string | undefined {
  // The autotls-issued multiaddr looks like:
  //   /ip4/X.X.X.X/tcp/PORT/tls/sni/<encoded-ip>.<peerID>.libp2p.direct/ws/p2p/<peerID>
  // We only need the TCP port and the SNI hostname.
  for (const ma of node.getMultiaddrs()) {
    const str = ma.toString()
    const sniMatch = /\/sni\/([^/]+)/.exec(str)
    const portMatch = /\/tcp\/(\d+)\//.exec(str)
    if (sniMatch == null || portMatch == null) continue
    const sni = sniMatch[1]
    const port = portMatch[1]
    // Hide :443 in the URL; otherwise include it.
    return port === '443' ? `https://${sni}` : `https://${sni}:${port}`
  }
  return undefined
}

export async function startLibp2pRedirectServer(db: MigrationDB, opts: Options = {}): Promise<{ node: Libp2p; baseUrl: string }> {
  const port = opts.port ?? 0
  const certTimeoutMs = opts.certTimeoutMs ?? 5 * 60_000

  log('libp2p ingress: starting node...')
  const node = await createLibp2p({
    addresses: {
      listen: [
        `/ip4/0.0.0.0/tcp/${port}/ws`,
        `/ip6/::/tcp/${port}/ws`,
      ],
    },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      // `http` is required by `autoTLS` as a peer dependency on the libp2p HTTP
      // component (used internally for the p2p-forge registration request).
      http: http(),
      autoTLS: autoTLS(),
      autoNAT: autoNAT(),
      identify: identify(),
      keychain: keychain(),
      upnp: uPnPNAT(),
    },
  })

  const handler = makeRedirectHandler(db)

  // Re-patch the request handler on every cert lifecycle event. The
  // @libp2p/websockets listener rebuilds its https.Server on each
  // certificate:renew, so each renew has to re-bind our handler.
  node.addEventListener('certificate:provision', () => {
    const ok = patchListener(node, handler)
    log(ok ? 'libp2p ingress: redirect handler attached' : 'libp2p ingress: WSS listener not found on provision')
  })
  node.addEventListener('certificate:renew', () => {
    const ok = patchListener(node, handler)
    log(ok ? 'libp2p ingress: redirect handler re-attached after cert renew' : 'libp2p ingress: WSS listener not found on renew')
  })

  // Wait for first cert + a derivable base URL.
  log('libp2p ingress: waiting for autotls certificate provision (cold start ~30s-2min)...')
  const baseUrl = await waitForBaseUrl(node, certTimeoutMs)
  log(`libp2p ingress: ready at ${baseUrl}`)
  log(`Pass it to pdp-submit: --source-base ${baseUrl}`)
  return { node, baseUrl }
}

function waitForBaseUrl(node: Libp2p, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      const url = deriveBaseUrl(node)
      if (url != null) {
        clearInterval(timer)
        resolve(url)
        return
      }
      const elapsed = Date.now() - start
      if (elapsed > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`libp2p ingress: no autotls cert after ${Math.round(timeoutMs / 1000)}s. Check that the libp2p WSS port is publicly reachable (UPnP, manual port forward, or public IPv6).`))
        return
      }
      if (elapsed > 30_000 && Math.floor(elapsed / 30_000) !== Math.floor((elapsed - 1000) / 30_000)) {
        log(`libp2p ingress: still waiting for cert (${Math.round(elapsed / 1000)}s); multiaddrs so far: ${node.getMultiaddrs().map((m) => m.toString()).join(', ') || '(none)'}`)
      }
    }, 1000)
  })
}
