# Public ingress for provider pulls

`redirect-serve` needs a public HTTPS URL that resolves to a public, routable
IP. The provider's PDP pull fetches `<source-base>/piece/{pcidv2}`, follows
the 302 to the gateway CAR, and re-validates the host on each hop. CGNAT
(`100.64.0.0/10`) and other private addresses are rejected.

Pass the **HTTPS origin only** (scheme + host, no path) as `--source-base`;
the tool appends `/piece/{pcidv2}` itself. The server answers only 302
redirects, so its bandwidth is negligible.

The `serve` daemon answers the same `/piece/{pcidv2}` route (GET and HEAD),
so a single process can carry the console, the commP runner, and the pull
source. `ipfs2foc serve --ingress cloudflared` spawns the tunnel itself and
checks reachability; for Funnel or a VPS, front the serve port (default
4321) and pass the public origin as `--public-base`. The standalone
`redirect-serve` below remains for the two-terminal workflow.

## Options at a glance

| Ingress | `--ingress` | Signup | CGNAT-friendly | Inbound port required | Cold start |
|---|---|---|---|---|---|
| Cloudflare Quick Tunnel | `cloudflared` | none | yes | none (outbound only) | ~10 s |
| Tailscale Funnel | `funnel` (default) | Tailscale account | yes | none (outbound only) | seconds |
| Manual (VPS / port-forward) | n/a, just `funnel` mode | varies | depends | yes | depends |

Both supported ingresses work behind CGNAT. Pick `cloudflared` to avoid
account signup; pick Funnel if you already run Tailscale or want a stable
`*.ts.net` hostname for a long-lived endpoint.

## Cloudflare Quick Tunnel (`--ingress cloudflared`)

Spawns `cloudflared tunnel --url http://localhost:<port>` against the local
redirect server. Cloudflare assigns a `*.trycloudflare.com` hostname with a
publicly-trusted TLS cert, runs an outbound QUIC connection to its edge, and
proxies inbound HTTPS to the local port.

Install the binary once:

```bash
brew install cloudflared            # macOS
# or download: https://github.com/cloudflare/cloudflared/releases
```

Run the ingress:

```bash
ipfs2foc redirect-serve --ingress cloudflared --port 4322
# logs: cloudflared ingress: ready at https://<words>.trycloudflare.com
```

Pass that URL as `--source-base` to `pdp-submit`. The tunnel exits with the
process; no orphan to clean up.

Cloudflare gates these "quick tunnels" behind their acceptable-use policy
and explicitly does not guarantee uptime
([docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/do-more-with-tunnels/trycloudflare/)).
Fine for one-shot CLI migrations. For a long-lived ingress, run a named
tunnel (needs a Cloudflare account) or use Funnel below.

### If the tunnel URL serves Cloudflare error 1033

cloudflared prints its URL before the tunnel registers with the edge over
QUIC (UDP port 7844). On networks that block that port, the URL resolves but
every request returns Cloudflare error 1033 ("unable to resolve" the tunnel)
— `serve`'s reachability probe reports the piece endpoint unreachable.
Force the TCP transport and front the port yourself:

```bash
cloudflared tunnel --url http://127.0.0.1:4321 --no-autoupdate --protocol http2
# then point serve at the printed URL:
ipfs2foc serve --public-base https://<words>.trycloudflare.com
```

## Tailscale Funnel (`--ingress funnel`)

Funnel publishes a Tailscale node on a `*.ts.net` hostname with a free TLS
cert. The migrator runs `tailscale funnel <port>` separately; this CLI's
funnel mode just starts the local HTTP server and trusts you to front it.

One-time prerequisites:

1. A [Tailscale](https://tailscale.com/) account and the Tailscale client
   installed on the machine running `redirect-serve`, with that node signed
   in.
2. In the Tailscale admin console under **DNS**, enable **MagicDNS** and
   **HTTPS Certificates**.
3. In **Access Controls**, grant the node the `funnel` node attribute (e.g.
   `nodeAttrs: [{ target: ["autogroup:member"], attr: ["funnel"] }]`).

The macOS app bundles the CLI at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`; on Linux and Windows
`tailscale` is on `PATH` after install.

```bash
ipfs2foc redirect-serve --port 4322 &       # default --ingress funnel
tailscale funnel --bg 4322                            # public :443 -> :4322
tailscale funnel status                               # prints https://<machine>.<tailnet>.ts.net
curl -I https://<machine>.<tailnet>.ts.net/healthz    # expect HTTP 200 before submit
```

Pass `https://<machine>.<tailnet>.ts.net` as `--source-base`.

## VPS / manual reverse proxy

Any host with a public IP and a TLS-terminating reverse proxy in front of
`:4322` works. The URL just has to satisfy the public-HTTPS-origin shape
above. Use `--ingress funnel` (the default) on the migrator; the "funnel"
label here means "you front this yourself" — Tailscale-specific setup steps
are not required.

## What the provider checks

For reference, Curio's pull client (`pdp/handlers_pull.go`,
`lib/robusthttp/ssrf.go`):

- Scheme must be `https` on the source-base and on every redirect target.
- Final host must resolve to a public IP. CGNAT (`100.64.0.0/10`),
  RFC1918, ULA, link-local, loopback, multicast are rejected.
- Up to 3 cross-origin redirects are followed, each re-validated.
- Final response must be HTTP 200 with a body (the gateway CAR).

The redirect server here answers the first hop (302); the gateway answers
the final hop (200 with the CAR bytes).

## Health check

Every ingress path serves `GET /healthz` → `200 ok`. Hit it from a different
network before running `pdp-submit` to confirm reachability:

```bash
curl -I https://<your-public-host>/healthz
```
