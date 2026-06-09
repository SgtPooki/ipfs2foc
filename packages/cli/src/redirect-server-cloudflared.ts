/**
 * Cloudflared "quick tunnel" ingress.
 *
 * Spawns `cloudflared tunnel --url http://localhost:<port>` against the local
 * redirect server. Cloudflare assigns a `*.trycloudflare.com` hostname with a
 * publicly-trusted TLS cert, runs an outbound QUIC connection to its edge, and
 * proxies inbound HTTPS to the local port. No account, no inbound port, works
 * behind CGNAT.
 *
 * The first stdout/stderr line carrying `https://<words>.trycloudflare.com` is
 * the public base URL. We log it and return it; the caller passes it as
 * `--source-base` to `pdp-submit`.
 *
 * Cloudflare gates these quick tunnels behind their acceptable-use policy and
 * does not guarantee uptime. Fine for one-shot migrations; for production, use
 * a named tunnel (which needs an account) or another ingress.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { log } from './util.ts'

const URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

interface Options {
  /** Local TCP port the redirect server is already listening on. */
  port: number
  /** Milliseconds to wait for the tunnel URL before bailing. Default 60 s. */
  startupTimeoutMs?: number
  /** Override the binary path; defaults to `cloudflared` on $PATH. */
  binary?: string
}

export async function startCloudflaredTunnel(opts: Options): Promise<{ baseUrl: string; child: ChildProcess }> {
  const binary = opts.binary ?? 'cloudflared'
  const startupTimeoutMs = opts.startupTimeoutMs ?? 60_000

  log(`cloudflared ingress: spawning '${binary} tunnel --url http://localhost:${opts.port}'`)
  const child = spawn(binary, ['tunnel', '--url', `http://localhost:${opts.port}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Fail-fast on missing binary.
  child.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log(
        `cloudflared ingress: '${binary}' not found on PATH. Install: 'brew install cloudflared' (macOS) or https://github.com/cloudflare/cloudflared/releases`
      )
    } else {
      log(`cloudflared ingress: spawn error: ${err.message}`)
    }
  })

  const baseUrl = await new Promise<string>((resolve, reject) => {
    let resolved = false
    const buf: string[] = []
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      buf.push(text)
      const match = URL_REGEX.exec(text) ?? URL_REGEX.exec(buf.join(''))
      if (match != null && !resolved) {
        resolved = true
        cleanup()
        resolve(match[0])
      }
    }
    const onExit = (code: number | null): void => {
      if (!resolved) {
        resolved = true
        cleanup()
        reject(
          new Error(
            `cloudflared exited (code ${code ?? 'null'}) before printing a tunnel URL. Tail:\n${buf.join('').split('\n').slice(-20).join('\n')}`
          )
        )
      }
    }
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        cleanup()
        child.kill('SIGTERM')
        reject(
          new Error(
            `cloudflared did not print a tunnel URL within ${Math.round(startupTimeoutMs / 1000)}s. Tail:\n${buf.join('').split('\n').slice(-20).join('\n')}`
          )
        )
      }
    }, startupTimeoutMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', onExit)
  })

  log(`cloudflared ingress: ready at ${baseUrl}`)
  log(`Pass it to pdp-submit: --source-base ${baseUrl}`)

  // Surface cloudflared exit so the operator sees the tunnel dropped.
  child.on('exit', (code, signal) => {
    log(`cloudflared ingress: tunnel exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
  })

  // Forward Ctrl-C cleanly so the child does not become an orphan.
  const shutdown = (): void => {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  return { baseUrl, child }
}
