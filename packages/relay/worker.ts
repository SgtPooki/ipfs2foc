/**
 * Cloudflare Worker entry for the ipfs2foc redirect relay.
 *
 * A Worker entry module may export only handlers (workerd rejects plain value
 * exports), so the routing logic lives in `./handler.ts` (a pure, sync,
 * unit-tested function) and this file wires it in as `fetch`. The entry adds the
 * one Cloudflare-specific concern — a per-IP rate limit on the pull path — that
 * cannot run outside the Workers runtime.
 */
import { handle, type RelayEnv } from './handler.ts'

/** The Workers Rate Limiting binding surface (declared locally, no deps). */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

interface WorkerEnv extends RelayEnv {
  /** Configured in wrangler.jsonc `ratelimits`. Absent in local dev/tests. */
  RELAY_RATE_LIMIT?: RateLimiter
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // Rate-limit the pull path per client IP. Health checks and 404s are exempt.
    // Skipped when the binding is absent (local dev) so behavior stays identical.
    if (env.RELAY_RATE_LIMIT != null && new URL(request.url).pathname.startsWith('/r/')) {
      const key = request.headers.get('cf-connecting-ip') ?? 'unknown'
      const { success } = await env.RELAY_RATE_LIMIT.limit({ key })
      if (!success) {
        return new Response('rate limit exceeded', {
          status: 429,
          headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
        })
      }
    }
    return handle(request, env)
  },
}
