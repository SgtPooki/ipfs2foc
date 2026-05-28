# Verify Actual Behavior

**Trigger:** Before asserting behavior of an external API, contract, library, or SDK that you have not opened in this session.

## Rule

- Read the source or run the thing before stating how it behaves.
- If the source is not available, write a probe script and observe the response shape.
- Cite the file:line in a code comment next to the call: `// verified: <repo>/path/file.go:NNN`.
- Mark unverified claims with a `// UNVERIFIED: ...` comment in code and a `_unverified_` note in PR descriptions. Do not paraphrase from recall.

## Examples

### Bad

"Curio's `pdp.addStatus` returns `ok=true` only when the AddPieces call fully succeeded."

### Good

Read `pdp/handlers.go:handleGetPieceAdditionStatus` in `filecoin-project/curio`. Confirmed: `txStatus='confirmed'` only reports tx landing. `addMessageOk` and `piecesAdded` are separate booleans. Cite the file in the code comment that interprets the response.

## Why

External APIs encode subtleties in field names that are not obvious from the name alone. The `pdp.addStatus` mistake (treating `txStatus='confirmed'` as success) silently corrupted migration state because the inner AddPieces call could fail while the tx landed.
