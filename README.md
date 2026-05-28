# foc-migrate

Migrate already-pinned IPFS CIDs onto **Filecoin Onchain Cloud (FOC)** without
re-chunking. Every original (already-announced) CID stays intact and
individually retrievable, while far fewer pieces are committed on-chain.

This is **Mode A**: the storage provider pulls the data directly from a trustless
gateway. Your machine never stores or relays the payload; it streams each object
once to compute the piece commitment.

## Goals

1. **Minimize bandwidth for the migrator.** The provider pulls payload bytes from
   the gateway. The migrator streams each object once to compute its commitment
   and stores none of it.
2. **Speed and resumability at scale.** Thousands of CIDs process concurrently,
   with all state in a database so a run resumes after any interruption.
3. **Preserve existing CIDs.** Data is stored as the CAR of the original DAG, so
   the same CID stays retrievable from the IPFS network. Already-announced CIDs
   keep working. Nothing is re-chunked.
4. **Verifiable migration.** A migrator can confirm every CID landed on FOC:
   piece commitments, commit transactions, data set ids, and per-aggregate links
   to the PDP explorer.
5. **Fewer on-chain operations.** Piece aggregation commits about
   `total_size / piece_size` pieces instead of one per CID. The provider submits
   and pays for the on-chain AddPieces; the migrator pays USDFC for storage plus
   a few setup transactions (deposit, operator approval). Network base fee is
   monitored so submission can pause during congestion.
6. **No stranded data.** The park→commit lifecycle is bounded so a provider is
   not asked to download far more than is then committed on-chain.
7. **Programmatic and operable.** Every step runs from the CLI or HTTP API, and a
   long migration runs in the background with a dashboard to start, pause,
   resume, add CIDs, and add gateways.
8. **Fast through pipelining.** The stages — computing piece commitments,
   packing manifests, submitting and committing aggregates, and producing
   confirmation links — overlap rather than run in series. The work is I/O-bound
   (gateway downloads, the provider's pulls, on-chain confirmation), so an
   aggregate can submit while later CIDs are still being hashed.

## How it works

1. **commP pass.** For each CID, fetch its CAR (`?format=car&dag-scope=all`) from
   a trustless gateway and stream it through the Filecoin piece hasher to get its
   **PieceCID v2** (FRC-0069). The CAR is rooted at the original CID, so storing
   it keeps the CID intact. The CAR root is checked against the requested CID.
2. **Pack.** Bin-pack pieces into aggregate pieces (default target 32 GiB,
   bounded by the provider's max piece size).
   Each aggregate's root is the **aggregate piece commitment**
   (`PieceAggregateCommP`): the merkle root of the sub-piece commitments, ordered
   largest-padded-first and zero-padded to the next power of two — the same value
   the provider re-derives on add.
3. **Pull.** For each sub-piece, ask the provider to `POST /pdp/piece/pull` from
   `<source-base>/piece/{pcidv2}` — a redirect endpoint that 302s to the original
   gateway CAR. The provider follows the redirect, downloads the CAR straight from
   the gateway, verifies its CommP against the declared pieceCID, and parks it.
   The migrator serves only the redirect, so no payload passes through it.
4. **Aggregate-add.** `POST /pdp/data-sets/{id}/pieces` with the parked
   sub-pieces (largest-padded-first). The provider recomputes the aggregate piece
   commitment over them, confirms it equals the submitted root, and lands one
   on-chain AddPieces. With the data set's `withIPFSIndexing` set, the provider indexes
   each parked CAR's blocks, so every original CID stays retrievable from the IPFS
   network by the same CID.

The on-chain operation count is about `total_size / piece_size` rather than one
per CID, and no payload bytes pass through your machine beyond the single commP
read.

### Why the redirect, and the pieceCID up front

A provider's PDP pull only admits source URLs shaped `/piece/{pieceCidV2}`, but it
follows cross-origin redirects (re-validating only scheme + public host), so a
`/piece/{pcidv2}` endpoint that 302s to `/ipfs/{cid}?format=car` lets the provider
pull the CAR straight from the gateway. Every flow takes the pieceCID up front:
the provider verifies pulled bytes against the pieceCID you supply, and no
endpoint returns a pieceCID it computed for you, so the commP pass (step 1) is
required regardless.

### Aggregate root

The aggregate root is the **aggregate piece commitment** — the value Curio
recomputes on add via `commputils.PieceAggregateCommP` (`go-commp-utils`). This
tool computes the same value locally (`src/piece-aggregate.ts`: the trunc-254
merkle of the sub-piece commitments, largest-first, zero-padded to the next power
of two), so the on-chain add validates. The add rejects a mismatched root, so a
successful commit confirms the local computation.

## Requirements

- **Node 26+** (uses the built-in `node:sqlite`).
- A source that serves **deterministic trustless CARs**. Known working:
  `gateway.pinata.cloud`, `trustless-gateway.link`. A gateway that returns
  reassembled files instead of CARs will not work; `probe` reports which case a
  gateway falls into.

```bash
npm install   # or pnpm install
```

## Usage

```bash
# Check whether a gateway serves deterministic CARs for a CID
node src/index.ts probe <cid> [--gateway https://gateway.pinata.cloud]...

# Compute one PieceCID v2
node src/index.ts commp <cid>

# Full pipeline: commitments + aggregate packing into a SQLite DB
node src/index.ts plan --cids cids.txt [--db migrate.db] [--piece-size 32GiB] [--concurrency 8]

# Progress and the aggregate plan
node src/index.ts status [--db migrate.db]

# Emit sptool manifest(s) from the DB
node src/index.ts export [--db migrate.db] [--aggregate 0] [--out ./out]

# Background daemon + browser dashboard (start/pause/resume, add CIDs, add gateways)
# --network/--rpc-url enables the base-fee monitor on the dashboard
node src/index.ts serve [--db migrate.db] [--cids cids.txt] [--port 4321] [--network calibration]

# Confirm CurioAuth + client allow-listing against a provider (read-only; PRIVATE_KEY env)
node src/index.ts auth-check --provider https://<sp-host>

# Current network base fee and whether to pause submission
node src/index.ts gas --network calibration [--max-base-fee 1000000]

# Redirect server: GET /piece/{pcidv2} -> 302 to the original gateway CAR.
# Front it with a public HTTPS ingress (see "Public ingress" below).
node src/index.ts redirect-serve --db migrate.db --port 4322

# Migrate via the PDP pull path: provider pulls each sub-piece CAR through the
# redirect, parks it, then one aggregate-add per aggregate. (PRIVATE_KEY env)
node src/index.ts pdp-submit --db migrate.db --data-set-id <id> --network calibration \
  --source-base https://<public-host> [--max-in-flight 4] [--max-base-fee 1000000] [--pull-batch 32]

# Alternative (only on a provider with mk20 EnableDealMarket): single-deal submit
node src/index.ts submit --db migrate.db --data-set-id <id> --network calibration
```

`cids.txt`: one CID per line; blank lines and `#` comments are ignored.

### Dashboard

`serve` starts an HTTP server (default `http://localhost:4321`) that runs the
commP pass in the background and shows live progress: piece counts, the aggregate
plan with each aggregate's status and parent CID, parked-but-uncommitted count,
and failures. Controls: start, pause, resume, retry failed, add CIDs (paste or
`POST /api/cids`), set gateways (`POST /api/gateways`). All state is the DB, so
the process can be stopped and resumed.

### Migrating (PDP pull path)

`pdp-submit` drives each planned aggregate onto a provider over the PDP API,
which is served by default public Curio providers — no mk20, no payload relay:

1. Presign the FWSS `AddPieces` authorization for the sub-pieces (Synapse SDK),
   then `POST /pdp/piece/pull` with each `sourceUrl = <source-base>/piece/{pcidv2}`.
2. The provider follows the redirect to the gateway CAR, downloads and verifies
   each sub-piece's CommP, and parks it.
3. Presign over the aggregate root, then `POST /pdp/data-sets/{id}/pieces` with
   the parked sub-pieces. The provider recomputes the aggregate piece commitment,
   confirms it matches the submitted root, and lands one on-chain AddPieces.

```bash
# 1. Serve the redirect locally and expose it publicly (see Public ingress)
node src/index.ts redirect-serve --db migrate.db --port 4322

# 2. Submit (PRIVATE_KEY env; provider + clientDataSetId resolved from the data set)
source .env
node src/index.ts pdp-submit --db migrate.db --data-set-id <id> --network calibration \
  --source-base https://<public-host>
```

The provider's HTTP layer is open (default NullAuth); authorization is the FWSS
`extraData` blob carried in each call. Submission honors the in-flight cap, the
base-fee gate, and provider pull backpressure (HTTP 429 + `Retry-After`).

The migrator must own (or hold a signature for) the data set's FWSS payer. To
keep original CIDs retrievable over IPFS, the data set must be created with
`withIPFSIndexing` in its FWSS metadata (set at create time, not per add).

### Public ingress for the redirect server

The provider's pull download fetches `<source-base>/piece/{pcidv2}` over plain
HTTPS and follows the cross-origin redirect to the gateway, so `redirect-serve`
needs a public HTTPS URL that resolves to a public IP. Options:

- **Tailscale Funnel** (free). One-time, in the Tailscale **admin console** (the
  CLI alone cannot enable these):
  1. DNS → enable **MagicDNS** and **HTTPS Certificates**.
  2. Access Controls → grant the node the **`funnel`** node attribute.

  Then, locally (the macOS app bundles the CLI at
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`):
  ```bash
  tailscale funnel 4322          # public :443 -> local redirect server :4322
  tailscale funnel status        # prints https://<machine>.<tailnet>.ts.net
  ```
  Use that `https://<machine>.<tailnet>.ts.net` as `--source-base`. It is a public
  hostname (resolves to Tailscale's public edge), not a tailnet `100.64.0.0/10`
  address — the provider's pull client rejects CGNAT. Without the admin-console
  HTTPS step, `tailscale funnel` cannot provision a cert (`tailscale cert` reports
  "HTTPS cert support is not enabled").
- **Cloudflare Tunnel** (free) or a small VPS with Caddy also work. The server
  serves only 302 redirects, so bandwidth is negligible.

### Alternative: mk20 single-deal submission

`submit` sends each aggregate as one mk20 deal (manifest of HTTP-pull sub-pieces;
the provider pulls and aggregates). It requires a provider running Curio with
`Subsystems.EnableDealMarket = true`, which is off by default and off on the
public calibration providers tested (ids 2, 4, 9). Diagnostic: a well-formed deal
to `POST /market/mk20/deal` returns an empty-body HTTP 500 when the deal market is
disabled, while `/contracts` and `auth-check` still succeed. `export` writes a
`<pcidv2>\t<url>` manifest for `sptool toolbox mk20-client` as well.

## Aggregate lifecycle and park/commit safety

Each aggregate moves through: `planned` → `submitted` → `parked` → `committed`
(or `failed`). `parked` means the provider has downloaded and verified every
sub-piece but nothing is on-chain yet. The database tracks the count of
aggregates at `submitted`/`parked` that have not reached `committed`, and the
dashboard surfaces it.

`pdp-submit` caps that in-flight count (`--max-in-flight`), so a provider is not
asked to download far more than is then committed, and it pauses when the network
base fee is above `--max-base-fee`.

Repacking only touches `planned` aggregates. Once an aggregate is `submitted` or
beyond, its index and members are frozen, and its CIDs are excluded from future
packing.

## Network gas

The provider submits and pays for the on-chain AddPieces and data set creation.
A migrator's own gas is limited to setup transactions (USDFC deposit, operator
approval); storage is paid in USDFC, which dominates cost.

Filecoin gas cost scales with the block base fee, and PDP transactions burn a
large amount of gas, so network congestion multiplies cost. The `gas` command
reads the latest block base fee (attoFIL/gas; floor 100) and reports a level:
`ok`, `rising`, or `spike`. Above `--max-base-fee` (default 1,000,000) the level
is `spike`, and `pdp-submit` pauses there. With `--network` or `--rpc-url`, the
dashboard shows the live base fee and flags when to pause.

## State

State lives in the SQLite database (`migrate.db` by default): each CID's piece
commitment and status, the aggregate plan, and per-aggregate lifecycle (deal id,
data set id, piece id, transaction hash). A run resumes from here; re-running
`plan` computes only CIDs that are not yet `done` and retries failures.

Tables: `pieces`, `aggregates`, `aggregate_members`.

## Roadmap

- **Idempotent add across a provider error.** When the provider's add returns a
  5xx after the on-chain AddPieces already landed (its tx submission succeeds, a
  later bookkeeping step fails), `pdp-submit` loses the tx hash and a re-run adds
  the same aggregate a second time. Before adding, check the data set's active
  pieces for the aggregate root and skip (mark committed) if it is already
  present, so a retry reconciles instead of double-spending gas.
- **Concurrent pull batches.** `pdp-submit` pulls sub-piece batches one after
  another (each batch parks fully before the next starts). The provider's pull is
  the throughput floor, so overlapping batches up to `--max-in-flight` shortens a
  large run.
- **Per-run performance report.** The CLI logs stage throughput (commP MiB/s,
  provider pull MiB/s, add confirmation time). Persist these per run and surface
  them in the dashboard so an operator can tune `--concurrency`, `--max-in-flight`,
  and `--pull-batch` against the observed provider pull rate, which dominates a
  large migration.
- **Create a data set when none exists.** `pdp-submit` targets an existing data
  set (`--data-set-id`). Add a create-data-set step (with `withIPFSIndexing`) so a
  migrator without one can provision it, then add pieces.
- **Customer verification report**: a command that lets a customer confirm a
  migration is complete — every CID accounted for, the list of commit
  transactions and data set ids, and per-aggregate links to the PDP explorer
  ([calibration](https://pdp.vxb.ai/calibration), [mainnet](https://pdp.vxb.ai/mainnet)).
- **Accountless redirect host via js-libp2p.** Research running the redirect
  endpoint as a js-libp2p node that serves HTTP ([`@libp2p/http`](https://github.com/libp2p/js-libp2p-http))
  with an automatic TLS certificate from autotls / p2p-forge (`*.libp2p.direct`,
  no account, no manual Let's Encrypt). Open questions to resolve: whether a
  provider's plain Go `net/http` pull client reaches the node's HTTP handler over
  public TLS, and whether the node is reachable for that plain-HTTP client behind
  NAT (libp2p relay/holepunch serves libp2p connections, not arbitrary HTTP
  clients). If both hold, this replaces the dependency on Funnel/cloudflared/VPS.
- **Mode B** (sources without trustless CARs): retrieve through Helia (bitswap +
  trustless-gateway block brokers), assemble canonical CARs locally, and host
  each aggregate over public HTTPS for the provider to pull.

## Scope and limits (Mode A)

- The source must serve deterministic trustless CARs. Use `probe` to check.
- **Sub-piece size**: each CID's CAR must be within the provider's pull piece
  limit (`PieceSizeLimit`, derived from `MaxMemtreeSize = 1 GiB`, so ~1 GiB raw).
  A single CID whose CAR exceeds this cannot be pulled as one piece.
- **Aggregate piece size**: `--piece-size` is the target aggregate piece size,
  bounded by the provider's max piece size (the add proof type allows up to
  64 GiB). A piece that cannot fit an empty aggregate is reported as `oversized`,
  never silently dropped.
- **Sub-pieces per pull request**: the PDP pull admission `eth_call`-simulates
  AddPieces over the batch, and the PDPVerifier `PiecesAdded` event carries one
  piece CID per piece. The FVM caps a single actor event at 8192 bytes, so a pull
  batch of too many sub-pieces reverts admission (`total event value lengths
  exceeded the max size`). `pdp-submit` splits the pull into batches
  (`--pull-batch`, default 32), each with its own FWSS authorization. The
  on-chain aggregate-add stays one top-level piece, so the cap applies only to
  the pull batch, not to how many sub-pieces an aggregate holds.
- An aggregate is all-or-nothing at the provider: one unretrievable sub-piece
  fails its aggregate. The commP pass validates per-CID retrievability first.
