# Curio addStatus Has Three Signals

**Trigger:** Any code path that polls or interprets Curio's `pdp.addStatus` response.

## Rule

- Treat `txStatus`, `addMessageOk`, and `piecesAdded` as three independent signals.
- `txStatus='confirmed'` only means the tx landed on chain. It does not mean the inner AddPieces call succeeded.
- Success requires all three: `txStatus==='confirmed'` AND `addMessageOk===true` AND `piecesAdded===true`.
- Terminal states include `txStatus==='failed'` (with `ok=false`). Treat that as done-with-failure, not retryable.
- In the call-site code comment, cite both `src/pdp.ts` `addStatus` (this repo) and `pdp/handlers.go:handleGetPieceAdditionStatus` (Curio source).

## Examples

### Bad

```ts
const s = await pdp.addStatus(txHash)
if (s.txStatus === 'confirmed') markAdded(row)  // wrong: AddPieces may have reverted
```

### Good

```ts
const s = await pdp.addStatus(txHash)
const done = s.txStatus === 'confirmed' || s.txStatus === 'failed'
if (!done) return 'pending'
const ok = s.txStatus === 'confirmed' && s.addMessageOk === true && s.piecesAdded === true
if (ok) markAdded(row)
else markFailed(row, { txStatus: s.txStatus, addMessageOk: s.addMessageOk, piecesAdded: s.piecesAdded })
```

## Why

A confirmed tx can carry a reverted internal call. Collapsing the three signals into one boolean lets failed AddPieces calls masquerade as successes, which then corrupts the migration ledger.
