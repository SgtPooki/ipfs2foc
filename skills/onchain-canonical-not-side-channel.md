# On-Chain Is Canonical, Side Channels Are Not

**Trigger:** Writing a verification, reconciliation, or audit code path against a system whose state of record lives on chain (or another deterministic system of record).

## Rule

- Read canonical state from the system of record. For Filecoin PDP, that means contract calls.
- Do not substitute IPFS gateway HEAD probes, SP-reported HTTP status, or log scraping for canonical truth.
- Side-channel signals are supplementary at best; never let them flip a row to "verified".
- For PDP membership use `getActivePieces`. For proof-of-possession use `getDataSetLastProvenEpoch`.
- IPNI announcement checks (`/routing/v1/providers/{cid}`) and gateway HEAD probes are discoverability and liveness signals only. A failed IPNI lookup does not unverify a piece the chain says is committed; a passing IPNI lookup does not verify one the chain has not committed.

## Examples

### Bad

```ts
// "Piece is retrievable" -> mark migrated
const head = await fetch(`https://trustless-gateway.link/ipfs/${cid}`, { method: 'HEAD' })
if (head.ok) row.status = 'verified'
```

### Good

```ts
const active = await pdpVerifier.getActivePieces(dataSetId)
const provenEpoch = await pdpVerifier.getDataSetLastProvenEpoch(dataSetId)
if (active.includes(row.pieceId) && provenEpoch > row.addedAtEpoch) {
  row.status = 'verified'
}
```

## Why

Gateways cache, SPs lie, logs lag. The chain is the only source that decides whether a piece is in a data set and whether it has been proven. Using side channels as primary evidence produces false positives that survive into reports.
