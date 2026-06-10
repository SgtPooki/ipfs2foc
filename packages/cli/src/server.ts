/**
 * Daemon + migration console. A tiny node:http server that owns a Runner and
 * the DB, so a migration can run in the background while the operator watches
 * progress and controls it from a browser: start/pause/resume, add CIDs (paste
 * or upload a .txt), add gateways, retry failures.
 *
 * No web framework — just node:http serving the built browser console (the
 * same app the hosted site runs, adapting via GET /api/capabilities) plus
 * JSON APIs that stay curl-friendly for scripting.
 *
 * The server binds loopback only and checks the Host header on /api routes
 * (a DNS-rebound hostname must not read run state) and the Origin header on
 * mutating routes (a foreign page must not drive the runner). Requests
 * without an Origin — curl, scripts — pass.
 *
 * /piece/{pcidv2} and /healthz are deliberately NOT Host-checked: a public
 * ingress (cloudflared, funnel) fronts this port for provider pulls, and
 * those requests carry the public hostname. Through the tunnel that exposes
 * only read-only piece bytes, the health check, and the static console —
 * the /api control plane stays Host-gated.
 */

import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPABILITIES_SCHEMA_VERSION, type Capabilities } from 'ipfs2foc-core/capabilities'
import type { MigrationDB } from './db.ts'
import { type BaseFeeReading, classifyBaseFee, getBaseFee } from './gas.ts'
import { handlePieceRequest, PIECE_PATH } from './redirect-server.ts'
import type { Runner } from './runner.ts'
import {
  CHAIN_IDS,
  type ChainJob,
  createDataSetWithSession,
  PRESIGN_SAFETY_MARGIN_SECONDS,
  type SessionValidator,
  sessionAddressOf,
  sessionSubmitDeps,
  validateSessionOnChain,
} from './session-submit.ts'
import { runSubmitPdp } from './submit-pdp.ts'
import { log, parseCidList } from './util.ts'

export interface GasConfig {
  rpcUrl: string
  maxBaseFee: bigint
}

/** Chain-touching config for browser-signed submission (#25 Slice D). */
export interface SubmitConfig {
  rpcUrl: string
  maxBaseFee: bigint
  maxInFlight?: number
  pullBatch?: number
  pollMs?: number
}

/**
 * Public ingress for the /piece endpoint, as a mutable cell: the caller sets
 * `publicBase` once the tunnel is up (and `reachable` after the self-probe),
 * and capabilities/status read it live on every request.
 */
export interface IngressState {
  /** Public https base providers pull from ({publicBase}/piece/{pcid}), or null when none. */
  publicBase: string | null
  /** Self-probe result for {publicBase}/healthz; null = not checked yet. */
  reachable: boolean | null
}

export interface ServeOptions {
  db: MigrationDB
  runner: Runner
  port: number
  /** Network reported via /api/capabilities (the runner itself is chain-free). */
  network: 'mainnet' | 'calibration'
  /** Directory holding the built browser console; defaults to the bundled copy. */
  appDir?: string
  ingress?: IngressState
  gas?: GasConfig
  /** Enables /api/session + /api/submit + /api/data-sets (needs an RPC). */
  submit?: SubmitConfig
  /** Test seams. */
  sessionValidator?: SessionValidator
  submitDriver?: typeof runSubmitPdp
  probe?: (base: string) => Promise<boolean>
}

/**
 * Where the built browser console lives when none is given explicitly.
 *
 * PROVISIONAL PACKAGING (revisit before the app grows): the built app ships
 * inside the ipfs2foc tarball as `app-dist/` (see the package.json `files`
 * entry and the `build` script that produces it), trading ~8× package size
 * for a single atomic version. Candidates for later: a separate app assets
 * package, or an optionalDependency headless installs can omit. The
 * /api/capabilities schemaVersion keeps either move drift-safe.
 *
 * The relative hop works from both `dist/` (bundled) and `src/` (running the
 * sources directly) because both sit one level below the package root — keep
 * that invariant if the build output ever moves.
 */
function defaultAppDir(): string {
  return fileURLToPath(new URL('../app-dist/', import.meta.url))
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isLocalHost(hostHeader: string | undefined): boolean {
  if (hostHeader == null) return false
  // Host is `name[:port]`; a bracketed IPv6 literal keeps its brackets.
  const name = hostHeader.startsWith('[') ? hostHeader.replace(/\]:\d+$/, ']') : hostHeader.replace(/:\d+$/, '')
  return LOCAL_HOSTS.has(name.toLowerCase())
}

function isLocalOrigin(origin: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Self-probe the public ingress: GET {base}/healthz and require the body to
 * be this server's own "ok" (a tunnel edge error page can answer 200 to a
 * bare status check). Retries cover a cold tunnel.
 */
export async function probePublicBase(base: string, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(10_000), redirect: 'manual' })
      if (res.ok && (await res.text()) === 'ok') return true
    } catch {
      // retry below
    }
    if (i < attempts - 1) await new Promise((resolveSleep) => setTimeout(resolveSleep, 2_000 * (i + 1)))
  }
  return false
}

export async function startServer(opts: ServeOptions): Promise<Server> {
  const { db, runner, port, network, gas, submit } = opts
  const appDir = resolve(opts.appDir ?? defaultAppDir())
  const ingress: IngressState = opts.ingress ?? { publicBase: null, reachable: null }
  const sessionValidator = opts.sessionValidator ?? validateSessionOnChain
  const submitDriver = opts.submitDriver ?? runSubmitPdp
  const probe = opts.probe ?? probePublicBase

  // The single in-flight chain job (submit or data-set creation). One slot:
  // both kinds consume the session key and the aggregate lifecycle.
  let job: ChainJob | null = null

  const sessionInfo = (): unknown => {
    const row = db.loadSessionKey()
    if (row == null) return { present: false }
    const now = Math.floor(Date.now() / 1000)
    return {
      present: true,
      sessionAddress: row.sessionAddress,
      root: row.rootAddress,
      chainId: row.chainId,
      expiresAt: row.expiresAt,
      valid: row.expiresAt > now,
      canPresign: BigInt(row.expiresAt) - BigInt(now) > PRESIGN_SAFETY_MARGIN_SECONDS,
    }
  }

  const jobInfo = (): unknown =>
    job == null
      ? null
      : {
          running: job.running,
          kind: job.kind,
          dataSetId: job.dataSetId,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          lastError: job.lastError,
          lastResult: job.lastResult,
        }

  const startJob = (kind: ChainJob['kind'], dataSetId: number | null, work: () => Promise<void>): void => {
    const next: ChainJob = {
      kind,
      dataSetId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      running: true,
      lastError: null,
      lastResult: job?.lastResult ?? null,
    }
    job = next
    void work()
      .catch((err) => {
        next.lastError = err instanceof Error ? err.message : String(err)
        log(`${kind} failed: ${next.lastError}`)
      })
      .finally(() => {
        next.running = false
        next.finishedAt = new Date().toISOString()
      })
  }

  // Poll the network base fee in the background so the console can show it and
  // flag when submission should pause. Read-only; never blocks the commP loop.
  let baseFee: BaseFeeReading | null = null
  if (gas != null) {
    const poll = async (): Promise<void> => {
      try {
        baseFee = classifyBaseFee(await getBaseFee(gas.rpcUrl), gas.maxBaseFee)
      } catch (err) {
        log(`baseFee poll failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    void poll()
    setInterval(() => void poll(), 20_000).unref()
  }
  const gasStatus = (): unknown =>
    baseFee == null
      ? null
      : {
          baseFee: baseFee.baseFee.toString(),
          multipleOfFloor: baseFee.multipleOfFloor,
          level: baseFee.level,
          pause: baseFee.pause,
          maxBaseFee: gas?.maxBaseFee.toString() ?? null,
        }

  // Computed per request: pieceBase appears once the caller's tunnel is up.
  const capabilities = (): Capabilities => ({
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    backend: 'local',
    network,
    apiBase: '/api',
    pieceBase: ingress.publicBase,
    supportsAssembledPieces: true,
    supportsServerCommp: true,
    // The browser wallet grants a scoped session key and hands it over; this
    // daemon signs presigns and drives pull/add itself (#25 Slice D).
    supportsBrowserSigning: submit != null,
    // Provider pulls hit {pieceBase}/piece/{pcid}; a null pieceBase means the
    // ingress requirement is not satisfied yet.
    requiresPublicIngress: true,
  })

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = `${req.method} ${url.pathname}`

    const json = (status: number, body: unknown): void => {
      // A handler that failed mid-stream already sent headers; a second
      // writeHead would throw inside the catch-all. Drop the connection.
      if (res.headersSent) {
        if (!res.writableEnded) res.destroy()
        return
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    const readBody = async (): Promise<string> => {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(chunk as Buffer)
      }
      return Buffer.concat(chunks).toString('utf8')
    }

    void (async () => {
      try {
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
          if (!isLocalHost(req.headers.host)) {
            json(403, { error: 'forbidden: API is loopback-only' })
            return
          }
          const mutating = req.method !== 'GET' && req.method !== 'HEAD'
          if (mutating && req.headers.origin != null && !isLocalOrigin(req.headers.origin)) {
            json(403, { error: `forbidden: cross-origin request from ${req.headers.origin}` })
            return
          }
        }

        switch (route) {
          case 'GET /api/capabilities':
            json(200, capabilities())
            return

          case 'GET /api/status':
            json(200, {
              ...(status(db, runner) as object),
              gas: gasStatus(),
              ingress: { publicBase: ingress.publicBase, reachable: ingress.reachable },
              session: sessionInfo(),
              submit: jobInfo(),
            })
            return

          case 'GET /api/session':
            json(200, sessionInfo())
            return

          case 'DELETE /api/session':
            // Forget this daemon's copy only; on-chain revoke happens in the
            // browser, which still holds its own copy of the key.
            db.deleteSessionKey()
            json(200, { deleted: true })
            return

          case 'POST /api/session': {
            if (submit == null) {
              json(503, { error: 'signing is not configured on this daemon (no RPC); restart serve' })
              return
            }
            // Parse defensively: a JSON.parse SyntaxError can quote the body,
            // and this body carries key material — never echo it.
            let body: Record<string, unknown>
            try {
              body = JSON.parse(await readBody()) as Record<string, unknown>
            } catch {
              json(400, { error: 'invalid JSON body' })
              return
            }
            const key = body.sessionPrivateKey
            if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
              json(400, { error: 'sessionPrivateKey must be 0x + 64 hex chars' })
              return
            }
            const root = body.root
            if (typeof root !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(root)) {
              json(400, { error: 'root must be a 0x wallet address' })
              return
            }
            const chainId = Number(body.chainId)
            if (chainId !== CHAIN_IDS[network]) {
              json(409, {
                reason: 'network-mismatch',
                error: `this daemon runs ${network} (chain ${CHAIN_IDS[network]}); the session targets chain ${chainId}`,
              })
              return
            }
            const sessionAddress = sessionAddressOf(key)
            let expiresAt: bigint
            try {
              expiresAt = await sessionValidator(submit.rpcUrl, network, { root, sessionAddress })
            } catch (err) {
              json(502, { error: `chain read failed: ${err instanceof Error ? err.message : String(err)}` })
              return
            }
            if (expiresAt <= BigInt(Math.floor(Date.now() / 1000))) {
              json(422, {
                reason: expiresAt === 0n ? 'not-authorized' : 'expired',
                error:
                  expiresAt === 0n
                    ? `no on-chain grant found for session ${sessionAddress} from ${root}`
                    : `the on-chain grant for session ${sessionAddress} has expired`,
              })
              return
            }
            // Persist BEFORE answering: a browser reload right after the 200
            // must find the daemon already holding the session.
            db.saveSessionKey({
              chainId,
              rootAddress: root,
              sessionAddress,
              privateKey: key,
              expiresAt: Number(expiresAt),
            })
            log(
              `session key accepted: ${sessionAddress} (root ${root}, expires ${new Date(Number(expiresAt) * 1000).toISOString()})`
            )
            json(200, { sessionAddress, root, expiresAt: Number(expiresAt), valid: true })
            return
          }

          case 'POST /api/data-sets': {
            if (submit == null) {
              json(503, { error: 'signing is not configured on this daemon (no RPC); restart serve' })
              return
            }
            if (job?.running === true) {
              json(409, { reason: 'job-running', error: `a ${job.kind} job is already in progress` })
              return
            }
            const row = db.loadSessionKey()
            if (row == null) {
              json(409, { reason: 'no-session', error: 'no signing session — grant one in the console first' })
              return
            }
            if (BigInt(row.expiresAt) - BigInt(Math.floor(Date.now() / 1000)) <= PRESIGN_SAFETY_MARGIN_SECONDS) {
              json(409, {
                reason: 'session-margin',
                error: 'session expires inside the presign margin — extend it first',
              })
              return
            }
            let body: Record<string, unknown>
            try {
              body = JSON.parse(await readBody()) as Record<string, unknown>
            } catch {
              json(400, { error: 'invalid JSON body' })
              return
            }
            const providerId = Number(body.providerId)
            if (!Number.isInteger(providerId) || providerId <= 0) {
              json(400, { error: 'providerId must be a positive integer' })
              return
            }
            startJob('create-data-set', null, async () => {
              const result = await createDataSetWithSession(row, {
                network,
                rpcUrl: submit.rpcUrl,
                providerId: BigInt(providerId),
                cdn: body.cdn === true,
              })
              if (job != null) {
                job.dataSetId = result.dataSetId
                job.lastResult = { dataSetId: result.dataSetId, txHash: result.txHash }
              }
            })
            json(202, { state: 'running', kind: 'create-data-set' })
            return
          }

          case 'POST /api/submit': {
            if (submit == null) {
              json(503, { error: 'signing is not configured on this daemon (no RPC); restart serve' })
              return
            }
            if (job?.running === true) {
              json(409, { reason: 'job-running', error: `a ${job.kind} job is already in progress` })
              return
            }
            const row = db.loadSessionKey()
            if (row == null) {
              json(409, { reason: 'no-session', error: 'no signing session — grant one in the console first' })
              return
            }
            if (BigInt(row.expiresAt) - BigInt(Math.floor(Date.now() / 1000)) <= PRESIGN_SAFETY_MARGIN_SECONDS) {
              json(409, {
                reason: 'session-margin',
                error: 'session expires inside the presign margin — extend it first',
              })
              return
            }
            let body: Record<string, unknown>
            try {
              body = JSON.parse(await readBody()) as Record<string, unknown>
            } catch {
              json(400, { error: 'invalid JSON body' })
              return
            }
            const dataSetId = Number(body.dataSetId)
            if (!Number.isInteger(dataSetId) || dataSetId <= 0) {
              json(400, { error: 'dataSetId must be a positive integer' })
              return
            }
            // Ingress is the #1 failure mode: a provider pull against an
            // unreachable /piece fails silently. Probe fresh, not cached.
            if (ingress.publicBase == null) {
              json(409, {
                reason: 'ingress-unreachable',
                error: 'no public ingress — restart serve with --ingress cloudflared or --public-base',
              })
              return
            }
            const sourceBase = ingress.publicBase
            ingress.reachable = await probe(sourceBase)
            if (!ingress.reachable) {
              json(409, {
                reason: 'ingress-unreachable',
                error: `${sourceBase}/healthz is not answering — providers cannot pull; check the tunnel`,
              })
              return
            }
            startJob('submit', dataSetId, () =>
              submitDriver(
                db,
                {
                  network,
                  rpcUrl: submit.rpcUrl,
                  dataSetId,
                  sourceBase,
                  maxInFlight: submit.maxInFlight ?? 4,
                  maxBaseFee: submit.maxBaseFee,
                  pollMs: submit.pollMs ?? 15_000,
                  pullBatch: submit.pullBatch ?? 32,
                },
                sessionSubmitDeps(db, row, sessionValidator)
              )
            )
            json(202, { state: 'running', dataSetId })
            return
          }

          case 'POST /api/start':
            runner.start()
            json(200, { state: runner.state })
            return

          case 'POST /api/pause':
            runner.pause()
            json(200, { state: runner.state })
            return

          case 'POST /api/resume':
            runner.resume()
            json(200, { state: runner.state })
            return

          case 'POST /api/retry':
            runner.retryFailed()
            json(200, { state: runner.state })
            return

          case 'POST /api/cids': {
            const cids = parseCidList(await readBody())
            const added = runner.addCids(cids)
            json(200, { added, cids: cids.length })
            return
          }

          case 'POST /api/gateways': {
            const body = await readBody()
            let gateways: string[]
            try {
              const parsed = JSON.parse(body)
              gateways = Array.isArray(parsed) ? parsed : parsed.gateways
            } catch {
              gateways = body.split(/[\s,]+/).filter(Boolean)
            }
            runner.setGateways(gateways)
            json(200, { gateways: runner.gateways })
            return
          }

          default: {
            if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
              json(404, { error: `no route ${route}` })
              return
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              json(404, { error: `no route ${route}` })
              return
            }
            // Provider-facing routes come before the static console: the SPA
            // fallback would otherwise answer /piece/{pcid} with index.html
            // and a pull would download HTML as the "CAR".
            if (url.pathname === '/healthz') {
              res.writeHead(200, { 'content-type': 'text/plain' })
              res.end(req.method === 'HEAD' ? undefined : 'ok')
              return
            }
            const piece = PIECE_PATH.exec(url.pathname)
            if (piece != null) {
              await handlePieceRequest(db, piece[1], req, res)
              return
            }
            await serveApp(appDir, url.pathname, req, res)
          }
        }
      } catch (err) {
        json(500, { error: err instanceof Error ? err.message : String(err) })
      }
    })()
  })

  await new Promise<void>((resolveListen) => {
    // Loopback only: the console controls the runner and the API has no auth.
    server.listen(port, '127.0.0.1', resolveListen)
  })
  const actualPort = (server.address() as { port: number }).port
  log(`ipfs2foc console on http://localhost:${actualPort}`)
  return server
}

/** Serve the built browser console: static assets with an index.html fallback. */
async function serveApp(appDir: string, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!existsSync(join(appDir, 'index.html'))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(
      `browser console not found at ${appDir}\n\n` +
        'Build it first (pnpm -C packages/cli build) or point at a built copy\n' +
        'with --app-dir / IPFS2FOC_APP_DIR. Note: a build for the hosted site\n' +
        'uses a different base path and will not work here.\n'
    )
    return
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bad path')
    return
  }
  const candidate = resolve(join(appDir, decoded))
  if (candidate !== appDir && !candidate.startsWith(appDir + sep)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }

  let filePath = decoded === '/' ? join(appDir, 'index.html') : candidate
  let fileStat = await stat(filePath).catch(() => null)
  if (fileStat == null || !fileStat.isFile()) {
    // SPA fallback: extension-less paths are app routes; missing assets 404.
    if (extname(decoded) !== '') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    filePath = join(appDir, 'index.html')
    fileStat = await stat(filePath)
  }

  const isIndex = filePath === join(appDir, 'index.html')
  const headers: Record<string, string> = {
    'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'content-length': String(fileStat.size),
    // index.html references content-hashed assets; it must never go stale.
    // The hashed assets themselves are safe to cache forever.
    'cache-control': isIndex
      ? 'no-store'
      : decoded.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(filePath)
    stream.pipe(res)
    stream.on('error', reject)
    res.on('finish', resolveStream)
    res.on('close', resolveStream)
  })
}

function status(db: MigrationDB, runner: Runner): unknown {
  return {
    state: runner.state,
    active: runner.active,
    gateways: runner.gateways,
    aggregateSizeBytes: runner.aggregateSizeBytes.toString(),
    dbPath: db.path,
    lastError: runner.lastError,
    counts: db.counts(),
    aggregates: db.aggregates(),
    failures: db.failures().slice(0, 50),
  }
}
