# Memory-Aware Scaling

**Trigger:** Writing code that walks a per-asset or per-piece list that may grow to 100k+ rows at operator scale.

## Rule

- Estimate the list size at operator scale before allocating it.
- At 1M+ CIDs a flat string array is hundreds of MB; do not hold it just to sample 100 entries.
- Use two-pass walks with bounded per-iteration buffers, or stride / reservoir sampling that materializes only the sample.
- Stream from the data source (SQL cursor, async iterator) instead of `SELECT *` into an array.

## Examples

### Bad

```ts
const allCids: string[] = db.prepare('SELECT cid FROM assets').all().map(r => r.cid)
const sample = pickN(allCids, 100)
```

### Good

The shipped pattern lives in `packages/cli/src/report.ts` as `collectSample`. It walks aggregates in order, tracks an absolute index, and only loads an aggregate's member list when at least one stride target lands inside that aggregate's range. Peak memory is `O(sample size) + O(one aggregate's member count)`, not `O(total)`.

```ts
// see packages/cli/src/report.ts collectSample
let absolute = 0
let nextTarget = 0
for (const agg of committedAggs) {
  if (nextTarget >= targets.length) break
  const end = absolute + agg.memberCount
  if (targets[nextTarget] < end) {
    const cids = db.aggregateAssetCids(agg.idx)  // only the matching aggregate
    while (nextTarget < targets.length && targets[nextTarget] < end) {
      out.push(cids[targets[nextTarget] - absolute])
      nextTarget++
    }
  }
  absolute = end
}
```

## Why

Operator scale is not developer-laptop scale. Sampling at the SQL boundary keeps RSS flat regardless of input size.
