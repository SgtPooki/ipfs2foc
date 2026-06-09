# ipfs2foc redirect relay

A **stateless** redirect relay for the in-browser BYOW migration dApp. It is the
shared, multi-tenant stand-in for the CLI's per-operator redirect server
(`packages/cli/src/redirect-server.ts`): a browser tab cannot accept the inbound
`/piece/{pieceCidV2}` pull a storage provider makes, so the dApp points the
provider at this relay, and the relay 302-redirects each pull to the
trustless-gateway CAR the piece was committed over.

The relay holds no payload and stores nothing. The bytes (the multi-MB CAR) go
from the gateway to the provider directly, never through the relay — so it costs
no bandwidth and, on Cloudflare, runs within the free tier (Worker requests
only; no KV).

## How it works — routing in the path

The dApp hands the provider a `sourceUrl` shaped:

```
https://<worker>.workers.dev/r/{gatewayHost}/{cid}/piece/{pieceCidV2}
```

Curio's pull validator (`pdp/pull_types.go#ValidatePullSourceURL`) only requires
the path to **end** with `/piece/{pieceCid}` (the regex is not start-anchored)
and the captured pieceCid to equal the on-chain value, over HTTPS to a public
host. So the dApp prepends `/r/{gatewayHost}/{cid}`, and the relay recovers the
gateway + CID from the prefix and 302s to
`buildCarUrl(https://{gatewayHost}, {cid})` — rebuilt with the same
`ipfs2foc-core` builder the migrator committed over, so the provider reads
byte-identical bytes. `{pieceCidV2}` is only there to satisfy the suffix rule;
the relay ignores it (the provider verifies it).

`GET /healthz` → `200`. Everything else → `404`.

## Why it is safe

- **No open redirector.** The relay never echoes a client URL. `{gatewayHost}`
  must be an **exact** member of the allowlist — a bare hostname matched
  literally, not a URL parsed for its `.hostname` — so ports, userinfo
  (`evil@host`), IDN homographs, and percent-escapes cannot smuggle a different
  target. The `Location` is built from the allowlist's own string.
- **Byte-safety.** `{cid}` must be a canonical CIDv1 (it round-trips to itself);
  the CID is the CAR root, so a re-encoded CID would mean different bytes and a
  different commP. The relay embeds the exact string the browser hashed.
- **Strict, decode-free parsing.** Exactly six path segments; any `%` is
  rejected (valid hostnames and CIDv1s never need encoding); the path length is
  bounded.

Built-in allowlist: the hosts in `DEFAULT_GATEWAYS`
(`trustless-gateway.link`). Widen it by config via `ALLOWED_GATEWAY_HOSTS`
(comma-separated hostnames), not code.

### Operational notes

- **Redirect budget.** Curio follows at most 3 redirects and the relay spends
  one. A gateway that itself redirects more than twice (path→subdomain, CDN
  edge) will fail the pull. Admission criterion for the allowlist: a gateway may
  use **at most two** of its own redirects on the canonical CAR URL. Verify with
  `curl -sI "$(node -e '…buildCarUrl…')"` per gateway before adding it.
- **Abuse.** Because there is no registration step, anyone can craft a URL that
  302s to a gateway CAR (the provider still re-verifies commP, so this is a
  bandwidth/ToS concern, not an integrity one). Add a Cloudflare rate-limiting
  rule on `/r/*` before a public launch; `observability` is enabled so the 302s
  are visible in Workers Logs.
- **`*.workers.dev`** is blocked on some corporate/SP networks; a custom domain
  removes that and decouples the published `sourceUrl` from the CF account.

## Validate

1. **Unit** — `test/relay-worker.test.ts` (via the repo's `npm test`) drives the
   handler directly: the canonical-URL 302, the host/CID/path guards, and the
   adversarial cases (userinfo, port, look-alike, percent-encoding, CIDv0,
   arity, HEAD). No `wrangler`, no network.

2. **Real runtime, local** — `workerd` with no account needed:

   ```sh
   cd packages/relay && npx wrangler dev --local --port 8788
   H=trustless-gateway.link
   CID=bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
   PCID=bafkzcibdxzhqyefkufvnsmqlyrjyr3el6affnfo3l7ipfncjjzjl4hkaqhbaema3
   curl -sI "localhost:8788/r/$H/$CID/piece/$PCID"   # 302 + Location to the gateway CAR
   curl -sL "localhost:8788/r/$H/$CID/piece/$PCID" -o car   # follow to the gateway
   ```

3. **Full chain** — point the CLI's `pdp-submit --source-base` at a deployed
   relay against a real provider (calibration, #22). The provider pulls *through*
   the relay; no dApp needed to exercise the pull path. (Note: the CLI builds
   `{base}/piece/{pcid}` with a single base, so for the stateless shape the
   per-piece prefix is set by the dApp's submit, not the current CLI batch path.)

## Deploy

```sh
cd packages/relay
npx wrangler deploy            # provisions nothing — stateless
```

The Worker imports the canonical CAR-URL builder from `ipfs2foc-core`;
`wrangler` bundles it. No build step, no KV namespace.

## Scope

Passthrough migrations only (one source CID → one sub-piece). The assembled
multi-asset path needs byte-serving and stays with the CLI. See issue #23.
