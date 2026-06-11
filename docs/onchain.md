# How a migration lands on chain

The pipeline guides ([how it works](../README.md#how-it-works)) cover what
each command does. This page explains the invariants underneath — the facts
that stay true whether you migrate with this tool, the browser console, or
your own integration against the same contracts. Each claim links to the
code that enforces it; when this page and that code disagree, the code wins.

## The CAR bytes are the commitment

A PieceCID v2 is a hash over exact bytes, and for a migrated CID those bytes
are a CAR file. So the CAR serialization is not packaging — it is the
definition of the commitment. Two serializers that emit the same blocks in a
different order, or dedup differently, produce different PieceCIDs for the
same DAG.

The canonical form this project commits to is the trustless-gateway framing:
CARv1, single root, DFS pre-order, first-occurrence dedup
(`?format=car&dag-scope=all&car-version=1&car-order=dfs&car-dups=n`). Blocks
are content-addressed, so once the walk order and dedup rule are fixed, only
the DAG determines the bytes. The local exporter that mirrors this is
[`packages/core/src/car-export.ts`](../packages/core/src/car-export.ts); the
byte-level pin against the live gateway is
[`packages/cli/test/commp-piece-cid-regression.test.ts`](../packages/cli/test/commp-piece-cid-regression.test.ts),
which fixes (CID → CAR sha256 → PieceCID v2) triples that every hasher in
the project — CLI, browser console, relay — must reproduce.

The provider closes the loop: Curio's pull downloads the piece and recomputes
CommP against the PieceCID in the pull request
([`tasks/pdpv0/task_pull_piece.go`](https://github.com/filecoin-project/curio/blob/main/tasks/pdpv0/task_pull_piece.go)).
A serializer that drifts from canonical form does not produce subtly wrong
storage; it produces a pull that fails verification.

## Piece CIDs are deterministic across providers

Because the commitment is a pure function of the DAG and the fixed
serialization, two independent providers pulling the same CID compute the
same PieceCID — there is no per-provider salt, timestamp, or session input.
Redundant copies are therefore *verifiably* redundant: matching piece CIDs
across two data sets prove the same bytes landed twice. A migration that
produces different piece CIDs for the same source CID on different providers
has a serialization bug, not a provider difference.

Aggregates inherit the same property. The aggregate root is the merkle root
of the sub-piece commitments, largest-first, zero-padded to a power of two —
recomputed by the provider on add and rejected on mismatch. The local
implementation is
[`packages/core/src/piece-aggregate.ts`](../packages/core/src/piece-aggregate.ts),
byte-for-byte equal to Curio's `commputils.PieceAggregateCommP`
([go-commp-utils](https://github.com/filecoin-project/go-commp-utils)).

## Pieces stay CARs because indexing parses them

The pull path itself is shape-agnostic: Curio copies opaque bytes and checks
CommP, and the pull-source URL only has to end in `/piece/{pieceCidV2}` over
public HTTPS
([`pdp/pull_types.go`](https://github.com/filecoin-project/curio/blob/main/pdp/pull_types.go)).
Nothing at pull time requires a CAR.

The CAR framing becomes load-bearing one step later. On a data set created
with `withIPFSIndexing`
([`packages/cli/src/create-data-set.ts`](../packages/cli/src/create-data-set.ts)),
the provider runs a CAR indexer over each parked piece
([`tasks/pdpv0/task_pdp_v0_indexing.go`](https://github.com/filecoin-project/curio/blob/main/tasks/pdpv0/task_pdp_v0_indexing.go)).
That index is what makes the original CIDs retrievable from the IPFS network
after migration — and a parked piece that does not parse as a CAR fails
indexing with no recovery path. A piece that commits but never indexes is
stored and proven, yet invisible to IPFS retrieval. If retrievability by the
original CID is the point of your migration, every piece must be a valid CAR.

## AddPieces batches against a hard event cap

PDPVerifier's `PiecesAdded` event carries one piece CID per added piece, and
the FVM caps a single actor event at 8192 bytes — roughly 41 piece CIDs. A
batch over the cap does not partially succeed; the transaction reverts with
`total event value lengths exceeded the max size`. The cap also binds before
the transaction exists: Curio's pull admission `eth_call`-simulates the
AddPieces for the whole batch, so an oversized batch is refused at pull time.

This tool's `--pull-batch` (default 32) sizes pull requests under that
ceiling — see the comment at the batching loop in
[`packages/cli/src/submit-pdp.ts`](../packages/cli/src/submit-pdp.ts).
An aggregate stays one top-level on-chain piece regardless of how many
sub-pieces it carries, so the cap constrains the pull batch, not the
aggregate shape. Integrators writing their own AddPieces calls hit the same
wall: batching 5–10 pieces per transaction is comfortably safe at typical
piece-CID sizes; hundreds is a guaranteed revert.

## Committed is not proven

AddPieces landing on chain means the provider holds bytes matching the
commitment *at that moment*. Ongoing possession is a separate mechanism:
FilecoinWarmStorageService schedules challenge windows (roughly daily), and
the provider answers each with a possession proof. The relevant PDPVerifier
state is `nextChallengeEpoch` (when the next window opens) and
`lastProvenEpoch` — with one trap: at proving activation, `lastProvenEpoch`
is initialized to the activation epoch, so a nonzero value does not by itself
mean a proof has landed. The first real proof can only exist after the first
challenge window, about a day after data set creation.

`ipfs2foc report` reads these getters and reports "proven since latest
AddPieces" only when the last proven epoch postdates the newest add — see
[`packages/cli/src/report.ts`](../packages/cli/src/report.ts) and the
read-only wrappers in
[`packages/core/src/pdp-verifier.ts`](../packages/core/src/pdp-verifier.ts).
A migration is not "done" when the commit transaction confirms; it is done
when a proof covering the added pieces lands.

## Read state, not receipts

The chain's contract state is the canonical record. Side channels — gateway
probes, provider HTTP status pages, even transaction receipts — are
supplementary, and receipts specifically have a known failure mode: some
public Filecoin RPC endpoints return `null` from `eth_getTransactionReceipt`
for transactions that exist and succeeded (observed on mainnet while
`eth_getTransactionByHash` resolved the same hash). Code that treats a null
receipt as "not landed" double-submits.

This project reconciles against state instead: before and after each add,
`pdp-submit` pages the data set's active pieces
(`getActivePieces` in
[`packages/core/src/pdp-verifier.ts`](../packages/core/src/pdp-verifier.ts))
and skips roots already present. That guard exists because the provider's
add endpoint can return HTTP 500 *after* its on-chain AddPieces succeeded —
an integrator who retries on the 500 without checking state lands the same
piece twice.

## Two signing paths, one authorization model

The headless CLI signs with `PRIVATE_KEY`; the browser consoles never see
that key and sign with an on-chain-authorized session key scoped to creating
data sets and adding pieces, with an explicit expiry. Either way the
economic authority — USDFC deposit, operator approval, lockup — belongs to
the wallet, and the storage provider pays the gas for the transactions it
submits on the migrator's behalf via EIP-712 authorizations in `extraData`.
The full key-handling model, including where session-key material lives and
how revocation works, is specified in [SECURITY.md](../SECURITY.md), and the
money flows in [Network gas and payments](../README.md#network-gas-and-payments).
