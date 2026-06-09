# Migrate in the browser

The hosted console at
[sgtpooki.github.io/ipfs2foc](https://sgtpooki.github.io/ipfs2foc/) runs a
passthrough migration entirely in the tab: paste CIDs, get back each one's
PieceCID v2, then submit them to storage providers and watch each copy commit
on chain. Nothing to install, and no wallet key material ever enters the
page.

## What a run produces

For each CID, the console computes the piece commitment and builds the pull
URL through the stateless redirect relay. The "Download run manifest" button
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

## When to use the CLI instead

Bulk runs, assembled (multi-asset) pieces, and submission with a headless key
stay with the [CLI](../README.md). The browser console covers the
one-CID-one-piece passthrough case. The two compose: prepare in the console,
then `import-manifest` the saved run and submit from the CLI.
