# Source gateways for migration

Snapshot: 2026-05-28. Provider behavior drifts; if a row here disagrees with
what `probe` reports today, open an issue.

`foc-migrate` pulls each CID as a deterministic trustless CAR from an HTTPS
gateway. The source gateway must serve `/ipfs/{cid}?format=car&dag-scope=all`
with bytes that re-hash to the requested CID. Reassembled-file responses do
not work; the provider re-validates the CAR against the PieceCID on add.

Use `probe` against any candidate before planning a run:

```bash
node src/index.ts probe <cid> --gateway https://<your-gateway>
```

A future `foc-migrate analyze` subcommand (see
[#2](https://github.com/SgtPooki/foc-migrate/issues/2)) will sweep a CID list
against a gateway and report the pass rate. Until then, `probe` on a sample is
the check.

## Gateway matrix

| Pinning provider | Trustless gateway URL pattern | Trustless CAR | Status |
|---|---|---|---|
| Pinata | `https://gateway.pinata.cloud` | yes | working; default in this repo |
| Protocol Labs trustless gateway | `https://trustless-gateway.link` | yes | working; default in this repo |
| Filebase | `https://<bucket>.myfilebase.com/ipfs/<cid>` | per-bucket | probe required |
| Storj | gateway-MT share link | per-share | probe required |
| nft.storage (classic) | `https://nftstorage.link` | per-CID | probe required |
| web3.storage (w3up) | none public per account | n/a | needs operator-side gateway |
| Self-hosted Kubo | operator-provided HTTPS host | yes if configured | see below |

### Pinata

The dedicated gateway at `https://gateway.pinata.cloud` serves trustless CARs
with `?format=car&dag-scope=all` for CIDs the account has pinned. Dedicated
gateway hostnames under `*.mypinata.cloud` behave the same way. Gateway access
to private content may require a signed URL or JWT; the migrator passes the
gateway URL through verbatim, so an operator who needs auth can put the token
in the URL or front the gateway with a local proxy.

```bash
node src/index.ts probe <cid> --gateway https://gateway.pinata.cloud
```

### trustless-gateway.link

A public, no-account trustless gateway run by Protocol Labs. Useful as a
second source to cross-check a CID, or as the only source when the content is
already on the public IPFS network.

```bash
node src/index.ts probe <cid> --gateway https://trustless-gateway.link
```

### Filebase

Filebase exposes content via per-bucket subdomains
(`https://<bucket>.myfilebase.com/ipfs/<cid>`) and a shared
`https://ipfs.filebase.io` host. Trustless CAR support depends on the bucket's
gateway configuration; some buckets return reassembled files. Probe each
bucket before planning. The underlying S3 API serves objects keyed by upload,
not by CID, and is not a substitute for the gateway.

```bash
node src/index.ts probe <cid> --gateway https://<bucket>.myfilebase.com
```

### Storj

Storj distributes content via gateway-MT share links rather than a single
host. The share link resolves to a CID-addressable URL when generated with
"raw" / "trustless" linksharing; default share links return reassembled HTML
landing pages and do not work. Generate a per-CID share with linksharing
configured for CAR output, then probe.

### nft.storage (classic)

The `nftstorage.link` gateway has changed behavior across the classic-to-w3up
migration. Some CIDs still resolve, others 404 or fall back to a reassembled
response. Probe the specific CIDs in scope; expect to bridge through a
secondary gateway for misses.

### web3.storage (w3up)

w3up does not publish a per-account trustless gateway URL the migrator can
target directly. Operators on w3up will need to expose their content through a
gateway they control — a self-hosted Kubo (below), a Pinata account that pins
the same CIDs, or `trustless-gateway.link` if the content is on the public DHT.

### Self-hosted Kubo

A Kubo node fronted by HTTPS works as a source when:

- The gateway is reachable on a public hostname with a valid TLS certificate.
- `Gateway.DeserializedResponses` is set to `false` so `?format=car` is
  honored and reassembled responses cannot leak through.
- The node has the CIDs locally or can fetch them through Bitswap before the
  request times out.

See the Kubo gateway docs at
[docs.ipfs.tech/reference/kubo/rpc/](https://docs.ipfs.tech/reference/kubo/rpc/)
for the configuration surface.

## When `probe` reports `WARN`

`probe` prints `WARN` when the gateway answers but the bytes do not re-hash to
the requested CID, or when the response is not a CAR. That gateway cannot be
used as a source. Either fix the gateway configuration (Kubo) or pick another
row from the matrix.
