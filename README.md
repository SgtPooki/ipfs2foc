# foc-migrate

Migrate already-pinned IPFS CIDs onto **Filecoin Onchain Cloud (FOC)** without
re-chunking. Each original CID stays byte-for-byte intact and individually
retrievable over IPFS, while far fewer pieces are committed on-chain.

The storage provider pulls each object's bytes directly from a trustless IPFS
gateway. Your machine streams each object once to compute its piece commitment
and stores none of the payload.

## How it works

1. **commP pass.** For each CID, fetch its CAR (`?format=car&dag-scope=all`) from a
   trustless gateway and stream it through the Filecoin piece hasher to get its
   **PieceCID v2** (FRC-0069). The CAR is rooted at the original CID, so storing it
   keeps the CID intact, and the CAR root is checked against the requested CID.
2. **Pack.** Bin-pack pieces into aggregates by the `--piece-size` target (default
   32 GiB; cap it to the provider's maximum piece size). Each aggregate's root is the
   **aggregate piece commitment** — the merkle root of the sub-piece commitments,
   ordered largest-padded-first and zero-padded to the next power of two, the same
   value the provider re-derives on add.
3. **Pull.** For each sub-piece, ask the provider to `POST /pdp/piece/pull` from
   `<source-base>/piece/{pcidv2}` — a redirect endpoint that 302s to the gateway CAR.
   The provider follows the redirect, downloads the CAR from the gateway, verifies its
   CommP against the declared PieceCID, and parks it. The migrator serves only the
   redirect, so no payload passes through it.
4. **Aggregate-add.** `POST /pdp/data-sets/{id}/pieces` with the parked sub-pieces.
   The provider recomputes the aggregate piece commitment, confirms it equals the
   submitted root, and lands one on-chain AddPieces. With the data set's
   `withIPFSIndexing` set, the provider indexes each parked CAR's blocks, so every
   original CID stays retrievable from the IPFS network by the same CID.

The on-chain operation count is about `total_size / piece_size` rather than one per
CID, and no payload bytes pass through your machine beyond the single commP read.

### Why the redirect, and the PieceCID up front

A provider's PDP pull admits only source URLs shaped `/piece/{pieceCidV2}`, and it
follows cross-origin redirects (re-validating scheme and public host). A
`/piece/{pcidv2}` endpoint that 302s to `/ipfs/{cid}?format=car` lets the provider
pull the CAR straight from the gateway. The provider verifies pulled bytes against
the PieceCID you supply, so the commP pass (step 1) runs regardless.

### Aggregate root

The aggregate root is the **aggregate piece commitment**: the trunc-254 merkle of the
sub-piece commitments, largest-first, zero-padded to the next power of two. The same
value is recomputed by Curio (`commputils.PieceAggregateCommP`, `go-commp-utils`) on
add. `src/piece-aggregate.ts` computes it locally so the on-chain add validates; the
add rejects a mismatched root, so a successful commit confirms the local computation.
This value is verified byte-for-byte against `go-commp-utils` in `test/`.

## Requirements

- **Node 26+** (uses the built-in `node:sqlite`).
- A source that serves **deterministic trustless CARs**. Known working:
  `gateway.pinata.cloud`, `trustless-gateway.link`. A gateway that returns reassembled
  files instead of CARs does not work; `probe` reports which case a gateway falls into.
  See [`docs/sources.md`](docs/sources.md) for per-provider notes and probe commands.

```bash
npm install   # or pnpm install
```

## Prerequisites

Before running the quickstart, complete the one-time wallet setup on the network
you target (default `mainnet`; pass `--network calibration` for the testnet).

- **Wallet**: a wallet whose address is the FWSS payer for the data set you create
  or own. Export the key as `PRIVATE_KEY` (`0x` + 64 hex) in the environment. The
  same key signs the data-set creation, the pull authorization, and every
  AddPieces submission.
- **FIL** in that wallet for the migrator's own transactions: USDFC ERC-20 approve,
  FilecoinPay deposit, FilecoinWarmStorageService operator approval. These three
  steps happen once per payer; the storage provider pays gas for everything it
  submits on chain (createDataSet, AddPieces, proof of possession).
- **USDFC** deposited into the FilecoinPay contract, with FWSS approved as a
  payments operator with sufficient `rateAllowance` and `lockupAllowance`, and a
  funded balance that covers the minimum lockup plus a one-time sybil fee.
  `create-data-set` reverts otherwise. [`filecoin-pin`](https://github.com/FilOzone/filecoin-pin)
  automates the approve / deposit / operator-approval calls from its CLI or as a
  library. The [Synapse SDK](https://github.com/FilOzone/synapse-sdk) `Payments`
  helper exposes the same calls directly. PDP Scan
  (`https://pdp.vxb.ai/{network}`) shows the resulting account state.
- **Provider id**: choose a PDP-capable provider from the SP registry. PDP Scan
  lists registered providers at `https://pdp.vxb.ai/{network}/providers`; pass
  that numeric id as `--provider-id` to `create-data-set`. Skip this step if you
  are reusing an existing data set you own.
- **Trustless gateway**: confirm the gateway you intend to use returns
  byte-stable CARs for one of your CIDs with `probe` before running `plan`.

## Quickstart

Complete **Prerequisites** above first. Default network is **mainnet**; pass
`--network calibration` for the testnet. `redirect-serve` (step 2) and
`pdp-submit` (step 3) run concurrently in separate terminals.

```bash
export PRIVATE_KEY=0x...

# 0. (Once per provider) Provision a data set with withIPFSIndexing on a chosen
#    PDP provider. Skip if you already have a data set id you own. Note the
#    `dataSetId` printed; reuse it in steps 3 and 4.
node src/index.ts create-data-set --provider-id <provider-id>

# 1. Confirm a trustless gateway returns a deterministic CAR for one of your CIDs.
node src/index.ts probe <sample-cid> --gateway https://trustless-gateway.link

# 2. Compute piece commitments and pack aggregates into a SQLite DB.
printf '%s\n' <cid> > cids.txt
node src/index.ts plan --cids cids.txt --db migrate.db

# 3. (Terminal A — leave running) Serve the redirect with a public HTTPS
#    ingress. `--ingress cloudflared` spawns a no-signup Cloudflare tunnel and
#    logs the public URL; the default `funnel` mode expects you to front the
#    local port yourself (Tailscale Funnel / Cloudflare Tunnel / VPS). See
#    docs/ingress.md.
node src/index.ts redirect-serve --db migrate.db --port 4322 --ingress cloudflared

# 4. (Terminal B) Pull, park, and add each aggregate onto the provider's data set.
#    `--source-base` is the public HTTPS origin only (no path) — the URL
#    cloudflared (or `tailscale funnel status`) prints.
node src/index.ts pdp-submit --db migrate.db --data-set-id <data-set-id> \
  --source-base https://<public-host>

# 5. Confirm every CID landed: reconcile local state against the on-chain pieces.
node src/index.ts report --db migrate.db --data-set-id <data-set-id>
```

`cids.txt`: one CID per line; blank lines and `#` comments are ignored.

## Commands

```bash
# Check whether a gateway serves deterministic CARs for a CID
node src/index.ts probe <cid> [--gateway https://gateway.pinata.cloud]...

# Compute one PieceCID v2
node src/index.ts commp <cid>

# Full pipeline: commitments + aggregate packing into a SQLite DB
node src/index.ts plan --cids cids.txt [--db migrate.db] [--gateway URL]... \
  [--piece-size 32GiB] [--concurrency 8]

# Progress and the aggregate plan
node src/index.ts status [--db migrate.db]

# Background daemon + browser dashboard (start/pause/resume, add CIDs, add gateways)
node src/index.ts serve [--db migrate.db] [--cids cids.txt] [--gateway URL]... \
  [--port 4321] [--network mainnet|calibration] [--rpc-url URL] [--max-base-fee N]

# Current network base fee and whether to pause submission
node src/index.ts gas [--network mainnet|calibration] [--rpc-url URL] [--max-base-fee 1000000]

# Redirect server: GET /piece/{pcidv2} -> 302 to the gateway CAR
node src/index.ts redirect-serve [--db migrate.db] [--port 4322]

# Provision a new FWSS data set with withIPFSIndexing (PRIVATE_KEY env)
node src/index.ts create-data-set --provider-id <id> \
  [--network mainnet|calibration] [--rpc-url URL] [--cdn] [--timeout-seconds 600]

# Migrate via the PDP pull path (PRIVATE_KEY env)
node src/index.ts pdp-submit --db migrate.db --data-set-id <id> \
  --source-base https://<public-host> [--network mainnet|calibration] [--rpc-url URL] \
  [--max-in-flight 4] [--max-base-fee 1000000] [--pull-batch 32] [--poll-seconds 15]

# Verification report: reconcile a run against the data set's on-chain pieces
node src/index.ts report --db migrate.db --data-set-id <id> \
  [--network mainnet|calibration] [--rpc-url URL] [--json]
```

`pdp-submit` honors the in-flight cap, the base-fee gate, and provider pull
backpressure (HTTP 429 + `Retry-After`). If the provider's add errors after the
on-chain AddPieces already landed, `pdp-submit` confirms the aggregate against the data
set's active pieces and marks it committed instead of adding it again.

### Dashboard

`serve` starts an HTTP server (default `http://localhost:4321`) that runs the commP pass
in the background and shows live progress: piece counts, the aggregate plan with each
aggregate's status and parent CID, parked-but-uncommitted count, and failures. Controls:
start, pause, resume, retry failed, add CIDs (`POST /api/cids`), set gateways
(`POST /api/gateways`). All state lives in the DB, so the process can stop and resume.

## Public ingress for the redirect server

`redirect-serve` needs a public HTTPS URL resolving to a public IP. Two
built-in paths:

- `--ingress cloudflared` — spawns a Cloudflare quick tunnel
  (`*.trycloudflare.com`). No account, works behind CGNAT, requires the
  `cloudflared` binary on PATH.
- `--ingress funnel` (default) — you run the local HTTP server and front it
  yourself with Tailscale Funnel, Cloudflare Tunnel, or a VPS reverse proxy.

Setup details, prerequisites, and the public-HTTPS shape the provider
validates live in [`docs/ingress.md`](docs/ingress.md). Pass the **HTTPS
origin only** (scheme + host, no path) as `--source-base`.

## Aggregate lifecycle and park/commit safety

Each aggregate moves through `planned` → `submitted` → `parked` → `committed` (or
`failed`). `parked` means the provider has downloaded and verified every sub-piece but
nothing is on-chain yet. `pdp-submit` caps the count of aggregates at `submitted`/`parked`
that have not reached `committed` (`--max-in-flight`), so a provider is not asked to
download far more than is then committed, and it pauses when the network base fee is above
`--max-base-fee`.

Repacking touches only `planned` aggregates. Once an aggregate is `submitted` or beyond,
its index and members are frozen, and its CIDs are excluded from future packing.

## Network gas and payments

Two wallets spend on a migration, in different currencies.

The **storage provider** submits and pays the FIL gas for the on-chain transactions in
this flow: data set creation, AddPieces, and the recurring proof-of-possession
transactions. The migrator authorizes each by an EIP-712 signature carried in the call's
`extraData`, and the provider sends the transaction.

The **migrator** is the data set's FWSS payer and spends both currencies:

- **USDFC** for storage. Data set creation opens a payment rail from the migrator to the
  provider and requires the migrator to have deposited enough USDFC to cover the minimum
  lockup plus a one-time sybil fee; AddPieces raises the rail's locked amount as the data
  set grows. See `FilecoinWarmStorageService.dataSetCreated` / `piecesAdded` in
  [filecoin-services](https://github.com/FilOzone/filecoin-services).
- **FIL** for the migrator's own setup transactions, sent from the migrator's wallet:
  approving USDFC to the FilecoinPay contract, depositing USDFC, and approving
  FilecoinWarmStorageService as a payments operator with sufficient rate and lockup
  allowance.

Filecoin gas cost scales with the block base fee, and PDP transactions burn a large
amount of gas, so network congestion multiplies the provider's cost. The `gas` command
reads the latest block base fee (attoFIL/gas; floor 100) and reports a level: `ok`,
`rising`, or `spike`. Above `--max-base-fee` (default 1,000,000) the level is `spike`, and
`pdp-submit` pauses so submission waits out congestion.

## State

State lives in the SQLite database (`migrate.db` by default): each CID's piece commitment
and status, the aggregate plan, and per-aggregate lifecycle (data set id, transaction
hash). A run resumes from here; re-running `plan` computes only CIDs that are not yet
`done` and retries failures. Tables: `pieces`, `aggregates`, `aggregate_members`.

## Scope and limits

- The source must serve deterministic trustless CARs. Use `probe` to check.
- **Sub-piece size**: each CID's CAR must be within the provider's pull piece limit
  (`PieceSizeLimit`, ~1 GiB raw). `plan` does not check this limit; a CAR larger than the
  pull cap completes `plan` and then fails at `pdp-submit` pull time. Hold large CIDs out
  of the run until the migrator supports re-chunking.
- **Aggregate piece size**: `--piece-size` is the target aggregate piece size, bounded by
  the provider's maximum piece size (up to 64 GiB). A piece whose padded size exceeds the
  configured `--piece-size` is reported as `oversized` and not packed, never silently
  dropped; this is the aggregate-budget bound, not the pull cap.
- **Sub-pieces per pull request**: the pull admission `eth_call`-simulates AddPieces over
  the batch, and the PDPVerifier `PiecesAdded` event carries one piece CID per piece. The
  FVM caps a single actor event at 8192 bytes, so a pull batch of too many sub-pieces
  reverts admission. `pdp-submit` splits the pull into batches (`--pull-batch`, default
  32), each with its own authorization. The on-chain aggregate-add stays one top-level
  piece, so the cap applies to the pull batch, not to how many sub-pieces an aggregate
  holds.
- **Determinism**: the provider re-fetches the gateway CAR and recomputes CommP, so a byte
  difference is a permanent failure. `plan` pins one gateway origin and request shape per
  piece, and `redirect-serve` 302s to that exact URL.
- **All-or-nothing aggregate**: one unretrievable sub-piece fails its aggregate. The commP
  pass validates per-CID retrievability first.

## Roadmap

- **Concurrent pull batches.** `pdp-submit` pulls sub-piece batches one after another. The
  provider's pull is the throughput floor, so overlapping batches up to `--max-in-flight`
  shortens a large run.
- **Per-run performance report.** The CLI logs stage throughput (commP MiB/s, provider
  pull MiB/s, add confirmation time). Persist these per run and surface them in the
  dashboard so an operator can tune `--concurrency`, `--max-in-flight`, and `--pull-batch`
  against the observed provider pull rate, which dominates a large migration.
- **Sources without trustless CARs.** Retrieve through Helia (bitswap +
  trustless-gateway block brokers), assemble canonical CARs locally, and host each
  aggregate over public HTTPS for the provider to pull.
