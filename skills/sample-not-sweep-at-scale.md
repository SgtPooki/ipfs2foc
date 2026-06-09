# Sample, Not Sweep, At Scale

**Trigger:** Adding a verify or audit command that walks per-asset rows whose count scales with operator input.

## Rule

- Default to a stride sample. Gate the full sweep behind `--all`.
- Use deterministic stride: `offset = floor(i * total / sampleSize)` for `i in 0..sampleSize-1`.
- Print the sample size and stride so operators can reproduce the run.
- Cap fan-out concurrency. Defaults vary by command; see [`sensible-defaults.md`](./sensible-defaults.md) for the shipped values in `packages/cli/src/index.ts` (e.g. `--concurrency` and `--ipni-concurrency` default `8`; `--max-in-flight` defaults `4`). Expose the relevant flag for operators with headroom.

## Examples

### Bad

```ts
for (const row of db.prepare('SELECT cid FROM assets').iterate()) {
  await probe(row.cid) // 1M HTTP requests against the source gateway
}
```

### Good

```ts
const total = countAssets()
const n = args.all ? total : (args.sample ?? 100)
const step = total / n
for (let i = 0; i < n; i++) {
  const cid = cidAtOffset(Math.floor(i * step))
  await probe(cid)
}
```

## Why

A million-CID sweep over HTTP melts the source endpoint and any rate limit between. A stride sample with a fixed seed is reproducible across runs, so failures are debuggable.
