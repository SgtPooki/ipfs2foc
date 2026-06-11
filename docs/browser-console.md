# Migrate in the browser

The hosted console at
[sgtpooki.github.io/ipfs2foc](https://sgtpooki.github.io/ipfs2foc/) runs a
passthrough migration entirely in the tab: paste CIDs, get back each one's
PieceCID v2, then submit them to storage providers and watch each copy commit
on chain. Nothing to install, and no wallet key material ever enters the
page.

An inventory too large to paste loads as a file instead: pick or drop a
`cids.txt` (one CID per line, blank lines and `#` comments ignored — the
same shape the CLI's `--cids` reads) onto the input. The console streams the
file through the parser and reports how many CIDs it accepted and which
lines it rejected before anything runs; a CIDv0 and its CIDv1 form count
once.

## What a run produces

For each CID, the console computes the piece commitment and builds the pull
URL through the stateless relay, which streams the canonical CAR to the
provider and rebuilds any blocks the gateway's CAR endpoint fails to deliver. The "Download run manifest" button
saves the whole run as JSON — the per-piece commitments and pull URLs, plus
the gateway and relay they were computed against.

A saved manifest is also the hand-off to the CLI:

```bash
ipfs2foc import-manifest manifest.json --db migrate.db --network calibration
ipfs2foc pdp-submit --db migrate.db --data-set-id <id> \
  --source-relay <relay-base-url> --network calibration
```

`import-manifest` records the manifest's commitments as done pieces and packs
them into aggregates — recomputing nothing, since the console's hasher and the
CLI's are pinned byte-identical — leaving the DB exactly as if `plan` had
produced it. The manifest's network must match `--network`, a piece already
recorded with a different commitment refuses the whole import, and re-importing
the same file changes nothing. Prepare in the console, submit with a key that
never enters a browser.

The hand-off goes the other way too. `ipfs2foc export` writes the DB's prepared
pieces back out as the same manifest format, so a run prepared (or imported) on
the CLI can move to the console to sign with a browser wallet:

```bash
ipfs2foc export --db migrate.db --network calibration --out manifest.json
# or pipe it: ipfs2foc export --db migrate.db > manifest.json
```

Both directions speak one versioned schema (the single source of truth is
[`ipfs2foc-core/manifest`](https://github.com/SgtPooki/ipfs2foc/blob/main/packages/core/src/manifest.ts),
where the v1 fields are documented). The manifest is prepare-level — commitments
and pull URLs, not live submit state (transaction hashes, data-set id) — so it
re-imports into a fresh DB and re-derives the same plan; the local `.db` file
remains the record for resuming an in-flight submit on the same machine.

## Submitting from the browser

Submission needs three one-time things, and the wallet panel reports all of
them: USDFC deposited into Filecoin Pay, the storage service approved as a
payments operator, and an enabled signing session. Enabling signing is one
wallet approval that authorizes a temporary key — scoped to creating data
sets and adding pieces, nothing else — for a window you pick. The key signs
every submission step silently; extend it in place if a long run needs more
time, and revoke it from the same row when you are done.

Pick how many provider copies to store (two by default: a primary plus an
independent secondary) and press Submit. The browser moves no payload bytes:
the primary provider pulls the canonical CAR through the relay, secondaries
copy provider-to-provider from the primary, and each copy lands as a single
on-chain commit covering every piece in the run. The status table tracks each
copy from pull to committed data set.

## How the commitment is computed

The console does not hash a gateway response. It retrieves the DAG
block-by-block (each block hash-checked against its CID), serializes the
canonical trustless CAR locally, and hashes that. The result is byte-identical
to the CAR the provider later pulls — the same guarantee the CLI pins in its
regression suite — and a gateway that returns an incomplete DAG produces a
loud per-row error instead of a wrong commitment.

CIDv0 (`Qm…`) input is normalized to CIDv1 before anything is fetched, so the
committed bytes and the pull URL always use one canonical form.

## Verifying against the chain

The status table freezes each piece's state at the moment it committed. The
chain does not: a skipped piece may have been migrated later through the local
console, and a provider keeps proving possession long after the run ends.
"Verify on chain" next to a copy's data set reads the answer directly over a
public RPC — which pieces the data set actually holds and whether the
provider's latest accepted proof covers everything the run added. It needs no
wallet, payment setup, or signing session, and a previous run's submit state
stays visible (and verifiable) even before a wallet is connected.

Pieces the chain holds are marked found, and any of them still carrying a
skipped marker are cleared — a resume will not re-submit them. One case stays
out of reach: a piece migrated through the local packing path lives on chain
under the packed piece's commitment, not its own, so this page lists it as
not found and the packed piece as one it did not prepare. `ipfs2foc report`
on the local database reconciles those — see the
[local console guide](./local-console.md).

## Interruptions

Run state persists in the browser. Refreshing or reopening the tab restores
the CID list and finished rows; rerunning Prepare recomputes only what is
missing. A submit run resumes the same way: authorizations and submitted
transactions are saved as they happen, so pressing Submit after a reload
continues where the run stopped — it never signs or submits the same thing
twice. Clear starts over.

While a run is active the console holds a screen wake lock so the machine
does not sleep mid-run, and closing the tab asks for confirmation first.
Closing is still safe: providers finish in-flight pulls and submitted
commits on their own, and only new submissions wait for the tab to return.

## When a run outgrows the tab

The hosted console covers the one-CID-one-piece passthrough case. The most
common reason to leave it: **items smaller than the provider's minimum piece
size** (typically 1 MiB padded). Passthrough commits one piece per CID, so
small items are refused at submit — the console then offers to submit the
large ones and hands you a manifest of the remainder plus the exact commands
for the local packing path. Two steps up from the tab:

- The [local console](local-console.md) — the same app served by
  `ipfs2foc serve` — moves commP and submission onto your machine: it uses
  local cores and disk, serves assembled (multi-asset) pieces, and keeps
  submitting after the tab closes, still signing with a wallet-granted
  session instead of a raw key. A saved manifest (`import-manifest`) carries
  a hosted run over.
- The [headless CLI](../README.md) signs with `PRIVATE_KEY` for automation
  and bulk runs that should not involve a browser at all.
