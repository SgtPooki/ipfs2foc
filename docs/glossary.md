# Glossary

Operator-level definitions for the terms foc-migrate uses without inline
explanation. For protocol depth, follow the linked specs and contracts.

## Aggregate piece commitment

The merkle root of an aggregate's sub-piece commitments, ordered
largest-padded-first and zero-padded to the next power of two. `pdp-submit`
computes it locally so the on-chain AddPieces validates against the
provider's recomputation. See `commputils.PieceAggregateCommP` in
[go-commp-utils](https://github.com/filecoin-project/go-commp-utils) and
the local implementation in `src/piece-aggregate.ts`.

## Data set

The on-chain unit a storage provider proves possession of, created by the
migrator on FilecoinWarmStorageService. Each AddPieces call lands one
aggregate into a data set; the data set's `withIPFSIndexing` flag controls
whether each parked CAR's blocks are indexed for IPFS retrieval. See
[`FilecoinWarmStorageService`](https://github.com/FilOzone/filecoin-services/blob/main/service_contracts/src/FilecoinWarmStorageService.sol).

## FilecoinPay

The payments contract that holds USDFC deposits and meters payment rails
between a payer and a storage provider. The migrator deposits USDFC here
once and approves FilecoinWarmStorageService as a payments operator. See
[`Payments`](https://github.com/FilOzone/filecoin-services/blob/main/service_contracts/src/Payments.sol)
in filecoin-services.

## FilecoinWarmStorageService (FWSS)

The service contract that opens a payment rail per data set and lands
AddPieces transactions against the PDPVerifier. The migrator is the
**payer** on the rail; the storage provider is the **payee**. See
[`FilecoinWarmStorageService`](https://github.com/FilOzone/filecoin-services/blob/main/service_contracts/src/FilecoinWarmStorageService.sol).

## fr32

Filecoin's 32-byte word padding scheme: each 254 useful bits expand to
256 bits before commP hashing. A raw payload of N bytes occupies
`N × 128 / 127` padded bytes; the aggregate piece commitment is computed
over fr32-padded inputs. See
[go-fil-commp-hashhash](https://github.com/filecoin-project/go-fil-commp-hashhash).

## FRC-0069

The Filecoin Request for Comment that specifies **PieceCID v2** — a
CIDv1 that carries piece size and padding alongside the commP digest, so
a single CID identifies both the commitment and the piece's dimensions.
See [FRC-0069](https://github.com/filecoin-project/FIPs/blob/master/FRCs/frc-0069.md).

## PDP pull

Curio's provider-pull endpoint: the provider downloads a piece from a
URL the migrator supplies, verifies CommP against the declared PieceCID,
and parks it. The pull source must be shaped `/piece/{pieceCidV2}` and
served over public HTTPS. See [Curio PDP](https://github.com/filecoin-project/curio/tree/main/pdp).

## PieceCID v2

A CIDv1 whose multihash is the fr32-padded commP digest and whose codec
carries the piece's padded size. The provider re-derives this value
from the bytes it pulls and rejects a mismatch. Specified in
[FRC-0069](https://github.com/filecoin-project/FIPs/blob/master/FRCs/frc-0069.md).

## Sub-piece

One CID's CAR after commP hashing: the leaf of an aggregate. Each
sub-piece is below the provider's `PieceSizeLimit` (~1 GiB raw) and
contributes one commitment to the aggregate piece commitment.

## Trustless gateway

An IPFS gateway that serves verifiable CARs (`?format=car&dag-scope=all`)
rooted at the requested CID, so the caller can re-derive the CID from the
bytes. Reassembled-file gateways do not qualify. See
[IPIP-402](https://specs.ipfs.tech/ipips/ipip-0402/) and the
[trustless gateway specification](https://specs.ipfs.tech/http-gateways/trustless-gateway/).

## withIPFSIndexing

A data-set flag on FilecoinWarmStorageService. When set, the storage
provider indexes each parked CAR's blocks so the original CIDs stay
retrievable from the IPFS network after AddPieces lands. See the
`createDataSet` extraData fields in
[`FilecoinWarmStorageService`](https://github.com/FilOzone/filecoin-services/blob/main/service_contracts/src/FilecoinWarmStorageService.sol).
