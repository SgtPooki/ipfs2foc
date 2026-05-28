# No Defense-In-Depth As An Ignorance Mask

**Trigger:** About to add a "just in case" guard, fallback branch, retry, optional check, or layered validation against a condition you have not seen in source or in a probe.

## Rule

- Treat the urge to add a defensive layer as a red flag. Stop and ask: do I actually know whether this case can happen?
- Before adding the guard, read the source for the API/contract/library at the exact version the project depends on. Cite by symbol (`<repo> <path/file.ext> <SymbolName>`) that proves the case is real or impossible; line numbers drift.
- If the source says the case cannot happen at this version, do not add the guard. Add a `// verified: ... cannot return X at version Y` comment instead.
- If the source confirms the case can happen, handle it explicitly with the correct branch. Cite the source. No catch-all `if (maybe) ...`.
- If you cannot read the source (closed binary, missing repo), probe the live system and observe. Cite the probe.
- Multiple "defensive" branches stacked against the same unknown is a stronger smell than one. Collapse them into a single source-grounded check.
- Real defense-in-depth (auth + transport + persistence each enforcing the same invariant against different threats) is fine. Speculative layering against "what if the response is wrong somehow" is not.

## Examples

### Bad

```ts
// Just in case Curio returns ok=true but the tx actually failed,
// also check addMessageOk, and also re-query the chain, and also
// require piecesAdded to be true and also poll for two more seconds.
if (resp.ok && resp.addMessageOk && resp.piecesAdded) {
  const onChain = await reCheckChain()
  if (onChain) await sleep(2000)
  if (onChain) markAdded(row)
}
```

The five layers exist because the writer did not check what each field means. The real fix is to read `pdp/handlers.go handleGetPieceAdditionStatus` once and use the three documented signals.

### Good

```ts
// verified: filecoin-project/curio pdp/handlers.go handleGetPieceAdditionStatus
// txStatus='confirmed' + addMessageOk===true + piecesAdded===true is the
// terminal-success contract. No further chain re-check needed.
const ok = resp.txStatus === 'confirmed' && resp.addMessageOk === true && resp.piecesAdded === true
if (ok) markAdded(row)
```

## Why

A speculative guard rarely fires, so it goes untested. When the underlying assumption is wrong, the guard either fails silently or masks a real bug behind a fallback that papers over it. The fix is always cheaper than the maintenance cost of a stack of guards: ten minutes of reading source replaces a year of "why is this branch here?" archaeology. Defense-in-depth as a synonym for "I don't actually know" produces code that looks careful and behaves carelessly.
