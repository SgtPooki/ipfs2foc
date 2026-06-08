# ipfs2foc

[![npm version](https://img.shields.io/npm/v/ipfs2foc.svg)](https://www.npmjs.com/package/ipfs2foc)
[![Node](https://img.shields.io/node/v/ipfs2foc.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Migrate already-pinned IPFS CIDs onto Filecoin Onchain Cloud (FOC) without re-chunking.

Each original CID stays byte-for-byte intact and individually retrievable over
IPFS, while far fewer pieces are committed on-chain. The storage provider pulls
each object's bytes directly from a [trustless IPFS
gateway](docs/glossary.md#trustless-gateway); your machine streams each object
once to compute its piece commitment and stores none of the payload.

To run a passthrough migration with nothing installed — prepare and submit —
use the [browser console](docs/browser-console.md) —
[sgtpooki.github.io/ipfs2foc](https://sgtpooki.github.io/ipfs2foc/).

## Contents

- [Install](#install)
- [Requirements](#requirements)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Commands](#commands)
- [Recovery commands](#recovery-commands)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Aggregate lifecycle and park/commit safety](#aggregate-lifecycle-and-parkcommit-safety)
- [Public ingress for the redirect server](#public-ingress-for-the-redirect-server)
- [Network gas and payments](#network-gas-and-payments)
- [State](#state)
- [Scope and limits](#scope-and-limits)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Install

```bash
npm install -g ipfs2foc      # the `ipfs2foc` command
# or run without installing:
npx ipfs2foc --help
```

From source (development uses [pnpm](https://pnpm.io)):

```bash
git clone https://github.com/SgtPooki/ipfs2foc
cd ipfs2foc
pnpm install
node src/index.ts --help     # run directly; Node 26 strips the TypeScript types
```

## Requirements

- **Node 26+** (uses the built-in `node:sqlite`).
- A source that serves **deterministic trustless CARs**. The default is
  `trustless-gateway.link`; others (for example `gateway.pinata.cloud`) work via
  `--gateway`. A gateway that returns reassembled files instead of CARs does
  not work; `probe` reports which case a gateway falls into. See
  [`docs/sources.md`](docs/sources.md) for per-provider notes and probe
  commands.

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
- **Payment setup**: deposit USDFC into Filecoin Pay and approve FWSS as a
  payments operator with enough rate and lockup allowance, plus the minimum
  lockup and one-time sybil fee. `create-data-set` reverts without it.
  [`filecoin-pin`](https://github.com/filecoin-project/filecoin-pin) does the
  deposit and approvals in one command:

  ```bash
  export PRIVATE_KEY=0x...
  npx filecoin-pin@latest payments setup --auto    # add --network calibration for the testnet
  npx filecoin-pin@latest payments status          # confirm the approvals and balance
  ```

  The [Synapse SDK](https://github.com/FilOzone/synapse-sdk) `Payments` helper
  exposes the same calls directly, and PDP Scan (`https://pdp.vxb.ai/{network}`)
  shows the resulting account state.
- **Provider id**: choose a PDP-capable provider from the SP registry. PDP Scan
  lists registered providers at `https://pdp.vxb.ai/{network}/providers`; pass
  that numeric id as `--provider-id` to `create-data-set`. Skip this step if you
  are reusing an existing data set you own.
- **Trustless gateway**: confirm the gateway you intend to use returns
  byte-stable CARs for one of your CIDs with `probe` before running `plan`.

## Quickstart

Complete **Prerequisites** above first. Default network is **mainnet**; pass
`--network calibration` for the testnet. `redirect-serve` and `pdp-submit` run
concurrently in separate terminals.

> **First time?** Rehearse the whole flow on the testnet with the
> [calibration tutorial](docs/tutorial-first-migration.md) before spending real
> funds on mainnet.

```bash
export PRIVATE_KEY=0x...

# One-time payer setup: deposit USDFC and approve FWSS as a payments operator.
npx filecoin-pin@latest payments setup --auto

# 0. (Once per provider) Provision a data set with withIPFSIndexing. Note the
#    printed `dataSetId`; reuse it in steps 4 and 5.
ipfs2foc create-data-set --provider-id <provider-id>

# 1. Confirm a trustless gateway returns a deterministic CAR for one of your CIDs.
ipfs2foc probe <sample-cid> --gateway https://trustless-gateway.link

# 2. Compute piece commitments and pack aggregates (one source CID per sub-piece).
printf '%s\n' <cid> > cids.txt
ipfs2foc plan --cids cids.txt --db migrate.db

# 3. (Terminal A — leave running) Serve sub-pieces over public HTTPS.
#    `--ingress cloudflared` spawns a no-signup Cloudflare tunnel and logs the URL.
ipfs2foc redirect-serve --db migrate.db --port 4322 --ingress cloudflared

# 4. (Terminal B) Pull, park, and add each aggregate onto the provider's data set.
#    `--source-base` is the public HTTPS origin only (no path) from step 3.
ipfs2foc pdp-submit --db migrate.db --data-set-id <data-set-id> \
  --source-base https://<public-host>

# 5. Confirm every CID landed: reconcile local state against the on-chain pieces.
ipfs2foc report --db migrate.db --data-set-id <data-set-id>
```

`cids.txt`: one CID per line; blank lines and `#` comments are ignored.

`plan` is **INSERT-only**: re-running it after appending CIDs adds new
sub-pieces and aggregates without rewriting prior planning state. Existing
`submitted`/`parked`/`committed` aggregates are never touched.

### Single-asset vs multi-asset

The quickstart runs the **single-asset** path: each source CID becomes one
passthrough sub-piece pulled straight from the gateway, with no staging disk.
Use the **multi-asset** path when source CIDs are smaller than the provider's
`Min Piece Size` or you want fewer on-chain pieces per source CID. It replaces
step 2 with a plan that defers packing, then assembles multi-root CARs on disk:

```bash
ipfs2foc plan --cids cids.txt --db migrate.db --no-auto-pack
ipfs2foc pack-cars --db migrate.db --car-store /var/foc-cars --pack-target-size 512MiB
```

[`docs/personas.md`](docs/personas.md) maps disk, bandwidth, and time budgets to
concrete knob settings for both paths.

## Commands

```bash
# Check whether a gateway serves deterministic CARs for a CID
ipfs2foc probe <cid> [--gateway https://gateway.pinata.cloud]...

# Compute one PieceCID v2
ipfs2foc commp <cid> [--gateway URL]...

# Full pipeline: commitments + aggregate packing into a SQLite DB.
# Default auto-wraps each source CID as a passthrough sub-piece. Pass
# --no-auto-pack to defer sub-piece assembly to `pack-cars` (multi-asset).
ipfs2foc plan --cids cids.txt [--db migrate.db] [--gateway URL]... \
  [--piece-size 32GiB] [--concurrency 8] [--no-auto-pack]

# Load a run manifest saved by the browser console: records its piece
# commitments as done pieces (recomputing nothing) and packs aggregates,
# leaving the DB as if `plan` had produced it. Refuses on network mismatch
# or a conflicting prior commitment; re-import is a no-op.
ipfs2foc import-manifest <manifest.json> [--db migrate.db] \
  [--network mainnet|calibration] [--piece-size 32GiB] [--no-auto-pack]

# Multi-asset packer: assemble many source CIDs into one multi-root CAR per
# sub-piece, append aggregates over the new sub-pieces.
ipfs2foc pack-cars --db migrate.db --car-store <dir> [--gateway URL]... \
  [--pack-target-size 512MiB] [--fetch-concurrency 4]

# Progress and the aggregate plan
ipfs2foc status [--db migrate.db] [--json]

# Pre-flight a CID list against a gateway: pass rate, sizes, throughput estimate
ipfs2foc analyze [--cids cids.txt] [--db migrate.db] [--car-store <dir>] [--gateway URL] \
  [--sample 100|--all] [--probe-concurrency 8] [--bw-target URL] \
  [--network mainnet|calibration] [--json]

# Background daemon + browser dashboard (start/pause/resume, add CIDs, add gateways)
ipfs2foc serve [--db migrate.db] [--cids cids.txt] [--gateway URL]... \
  [--port 4321] [--network mainnet|calibration] [--rpc-url URL] [--max-base-fee N]

# Current network base fee and whether to pause submission
ipfs2foc gas [--network mainnet|calibration] [--rpc-url URL] [--max-base-fee 1000000]

# Sub-piece server: GET /piece/{pcidv2} -> 302 to the gateway CAR for a
# passthrough sub-piece, or byte-serves the assembled CAR file for a
# multi-asset sub-piece.
ipfs2foc redirect-serve [--db migrate.db] [--port 4322] [--ingress funnel|cloudflared]

# Provision a new FWSS data set with withIPFSIndexing (PRIVATE_KEY env)
ipfs2foc create-data-set --provider-id <id> \
  [--network mainnet|calibration] [--rpc-url URL] [--cdn] [--timeout-seconds 600]

# Migrate via the PDP pull path (PRIVATE_KEY env). The pull source is either
# your own redirect-serve origin (--source-base) or a shared stateless relay
# (--source-relay, passthrough sub-pieces only — no server of your own needed).
ipfs2foc pdp-submit --db migrate.db --data-set-id <id> \
  (--source-base https://<public-host> | --source-relay https://<relay-base>) \
  [--network mainnet|calibration] [--rpc-url URL] \
  [--max-in-flight 4] [--max-base-fee 1000000] [--pull-batch 32] [--poll-seconds 15]

# Verification report: reconcile a run against the data set's on-chain pieces
ipfs2foc report --db migrate.db --data-set-id <id> \
  [--network mainnet|calibration] [--rpc-url URL] [--json] \
  [--check-ipni <delegated-routing-url>] [--ipni-sample 100|--ipni-all] [--ipni-concurrency 8]
```

`plan`, `commp`, and `serve` also accept an opt-in IPFS fallback that recovers
from source-gateway 5xx/429 through an embedded node:

```bash
[--ipfs-fallback] [--ipfs-fallback-mode gateway-first] [--ipfs-fallback-timeout-seconds 120]
```

`pdp-submit` honors the in-flight cap, the base-fee gate, and provider pull
backpressure (HTTP 429 + `Retry-After`). If the provider's add errors after the
on-chain AddPieces already landed, `pdp-submit` confirms the aggregate against the
data set's active pieces and marks it committed instead of adding it again.

A run prepared in the [browser console](docs/browser-console.md) submits the
same way: `import-manifest` the saved manifest, then `pdp-submit
--source-relay` — the provider pulls each piece through the relay, so no
redirect server of your own is needed.

### Dashboard

`serve` starts an HTTP server (default `http://localhost:4321`) that runs the commP pass
in the background and shows live progress: piece counts, the aggregate plan with each
aggregate's status and parent CID, parked-but-uncommitted count, and failures. Controls:
start, pause, resume, retry failed, add CIDs (`POST /api/cids`), set gateways
(`POST /api/gateways`). All state lives in the DB, so the process can stop and resume.

## Recovery commands

These re-arm aggregates that did not reach `committed`. They are not part of a
routine migration; reach for them only when a run is stuck and you have read
[`docs/personas.md`](docs/personas.md) failure modes.

```bash
# Move `failed` aggregates back to `planned` so the next pdp-submit retries them
ipfs2foc reset-failed-aggregates [--db migrate.db] [--network mainnet|calibration]

# Re-arm `submitted`/`parked` aggregates that never confirmed.
# Only after verifying on chain that their roots are NOT present — re-arming an
# aggregate whose AddPieces actually landed lands a duplicate.
ipfs2foc retry-unconfirmed-aggregates [--db migrate.db] [--network mainnet|calibration]
```

## Troubleshooting

- **`probe` reports `WARN`.** The gateway answered but the bytes do not re-hash
  to the requested CID, or the response is not a CAR. That gateway cannot be a
  source. Fix the gateway config (Kubo: set `Gateway.DeserializedResponses` to
  `false`) or pick another from [`docs/sources.md`](docs/sources.md).
- **`set PRIVATE_KEY (0x + 64 hex)`.** `create-data-set` and `pdp-submit` read
  the signing key from the environment. Export it (`export PRIVATE_KEY=0x...`) or
  `source .env` before running.
- **`create-data-set` reverts.** The payer's USDFC deposit, FWSS operator
  approval, or allowances are insufficient. See [Prerequisites](#prerequisites).
- **Provider rejects the pull / public-host error.** `--source-base` must be the
  public HTTPS origin only (scheme + host, no path) and resolve to a public IP.
  CGNAT and private ranges are rejected. See [`docs/ingress.md`](docs/ingress.md).
- **`plan` reports a CID as `oversized`.** Its padded piece size exceeds the
  `--piece-size` aggregate budget. A CAR above the provider's per-piece pull
  limit (~1 GiB raw) cannot be migrated as one piece either; hold it out of the
  run until re-chunking is supported.
- **`pdp-submit` skips an aggregate: `sub-piece(s) below provider min piece size`.**
  In the single-asset path each source CID is its own sub-piece, and the provider
  enforces a minimum piece size (commonly 1 MiB). CIDs whose CAR pads below that
  floor cannot go through the passthrough path on that provider — use the
  multi-asset path (`plan --no-auto-pack` then `pack-cars --pack-target-size`
  at or above the provider minimum) to batch them into a large enough piece.
- **Submission pauses on `spike`.** The network base fee is above `--max-base-fee`.
  `pdp-submit` waits out the congestion; check with `ipfs2foc gas`.

[`docs/personas.md`](docs/personas.md) covers per-profile failure modes (gateway
flakes, disk pressure, idle-timeout cascades) and recovery.

## How it works

1. **commP pass.** For each CID, fetch its CAR (`?format=car&dag-scope=all`) from a
   trustless gateway and stream it through the Filecoin piece hasher to get its
   [**PieceCID v2**](docs/glossary.md#piececid-v2) ([FRC-0069](docs/glossary.md#frc-0069)). The CAR is rooted at the original CID, so storing it
   keeps the CID intact, and the CAR root is checked against the requested CID.
2. **Pack.** Group source CIDs into [**sub-pieces**](docs/glossary.md#sub-piece) and bin-pack those into aggregates by
   the `--piece-size` target (default 32 GiB; cap it to the provider's maximum piece size).
   In the **single-asset** path (`plan`'s default), each source CID becomes one
   [passthrough sub-piece](docs/glossary.md#passthrough-sub-piece) whose pull source is the gateway URL directly; no CAR file
   touches migrator disk. In the **multi-asset** path (`plan --no-auto-pack` followed
   by `pack-cars`), source CIDs are concatenated into [assembled sub-pieces](docs/glossary.md#assembled-sub-piece) — one
   multi-root CAR file per sub-piece under `--car-store`. Either way, each aggregate's
   root is the [**aggregate piece commitment**](docs/glossary.md#aggregate-piece-commitment) — the merkle root of its sub-piece
   commitments, ordered largest-padded-first and zero-padded to the next power of two,
   the same value the provider re-derives on add.
3. **Pull.** For each sub-piece, ask the provider via [PDP pull](docs/glossary.md#pdp-pull) to `POST /pdp/piece/pull` from
   `<source-base>/piece/{pcidv2}`. `redirect-serve` looks the sub-piece up locally and
   serves a passthrough sub-piece as a 302 to the gateway CAR or an assembled sub-piece
   as a byte-served local CAR file. The provider downloads it, verifies its CommP against
   the declared PieceCID, and parks it.
4. **Aggregate-add.** `POST /pdp/data-sets/{id}/pieces` with the parked sub-pieces.
   The provider recomputes the aggregate piece commitment, confirms it equals the
   submitted root, and lands one on-chain AddPieces. With the [data set's](docs/glossary.md#data-set)
   [`withIPFSIndexing`](docs/glossary.md#withipfsindexing) set, the provider indexes each parked CAR's blocks, so every
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

## Aggregate lifecycle and park/commit safety

Each aggregate moves through `planned` → `submitted` → `parked` → `committed` (or
`failed`). `parked` means the provider has downloaded and verified every sub-piece but
nothing is on-chain yet. `pdp-submit` caps the count of aggregates at `submitted`/`parked`
that have not reached `committed` (`--max-in-flight`), so a provider is not asked to
download far more than is then committed, and it pauses when the network base fee is above
`--max-base-fee`.

Repacking touches only `planned` aggregates. Once an aggregate is `submitted` or beyond,
its index and members are frozen, and its CIDs are excluded from future packing.

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

## Network gas and payments

Two wallets spend on a migration, in different currencies.

The **storage provider** submits and pays the FIL gas for the on-chain transactions in
this flow: data set creation, AddPieces, and the recurring proof-of-possession
transactions. The migrator authorizes each by an EIP-712 signature carried in the call's
`extraData`, and the provider sends the transaction.

The **migrator** is the data set's [FWSS](docs/glossary.md#filecoinwarmstorageservice-fwss) payer and spends both currencies:

- **USDFC** for storage. Data set creation opens a payment rail from the migrator to the
  provider and requires the migrator to have deposited enough USDFC to cover the minimum
  lockup plus a one-time sybil fee; AddPieces raises the rail's locked amount as the data
  set grows. See `FilecoinWarmStorageService.dataSetCreated` / `piecesAdded` in
  [filecoin-services](https://github.com/FilOzone/filecoin-services).
- **FIL** for the migrator's own setup transactions, sent from the migrator's wallet:
  approving USDFC to the [FilecoinPay](docs/glossary.md#filecoinpay) contract, depositing USDFC, and approving
  [FilecoinWarmStorageService](docs/glossary.md#filecoinwarmstorageservice-fwss) as a payments operator with sufficient rate and lockup
  allowance.

Filecoin gas cost scales with the block base fee, and PDP transactions burn a large
amount of gas, so network congestion multiplies the provider's cost. The `gas` command
reads the latest block base fee (attoFIL/gas; floor 100) and reports a level: `ok`,
`rising`, or `spike`. Above `--max-base-fee` (default 1,000,000) the level is `spike`, and
`pdp-submit` pauses so submission waits out congestion.

## State

State lives in the SQLite database (`migrate.db` by default): each CID's piece commitment
and status, the sub-piece (passthrough or assembled) it belongs to, the aggregate plan,
and per-aggregate lifecycle (data set id, transaction hash). A run resumes from here;
re-running `plan` computes only CIDs that are not yet `done`, retries failures, and
appends new sub-pieces and aggregates without disturbing prior planning state.
Tables: `pieces`, `sub_pieces`, `sub_piece_members`, `aggregates`,
`aggregate_members`.

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

## Documentation

The [`docs/`](docs/README.md) folder is organized by [Diátaxis](https://diataxis.fr/):

- **Tutorial** — [your first migration on calibration](docs/tutorial-first-migration.md),
  one CID end-to-end with a checkpoint at every step.
- **How-to** — [operator profiles](docs/personas.md) (disk/bandwidth/time budgets →
  knob settings, failure modes, recovery), [choosing a gateway](docs/sources.md),
  [public ingress](docs/ingress.md).
- **Reference** — [command reference](#commands) and [glossary](docs/glossary.md).
- **Explanation** — [how it works](#how-it-works),
  [gas and payments](#network-gas-and-payments), [scope and limits](#scope-and-limits).

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

## Contributing

Issues and pull requests welcome at
[github.com/SgtPooki/ipfs2foc](https://github.com/SgtPooki/ipfs2foc). See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the dev loop and conventions, and
[`SECURITY.md`](SECURITY.md) for key-handling and on-chain-spend guidance.

## License

[MIT](LICENSE)
</content>
</invoke>
