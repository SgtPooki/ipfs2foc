# Sensible Defaults

**Trigger:** Adding a new CLI flag, env var, or config knob.

## Rule

- Pick the default that produces the safest outcome for the most common operator. Opt-in flags toggle the expensive or destructive path, not the safe path.
- State the default value in `--help` text on the same line as the flag.
- Repo-specific defaults that must hold across new commands:
  - **Network:** `mainnet`. Calibration is `--network calibration`. See [`default-mainnet-network.md`](./default-mainnet-network.md).
  - **Cache:** on **(planned; not shipped)**. The cache flag will be `--car-store <dir>`; `docs/personas.md` tracks the design. Until shipped, do not add `--car-store` to new code paths.
  - **Sample size for verify / audit:** `100`. Full sweep is `--all` (or feature-specific, e.g. `--ipni-all`).
  - **Fan-out concurrency** (per-command, see `packages/cli/src/index.ts` for shipped values):
    - `--concurrency` (plan, serve): default `8`.
    - `--ipni-concurrency` (report's IPNI check): default `8`.
    - `--max-in-flight` (pdp-submit aggregates in flight): default `4`.
  - New fan-out knobs default to `8` unless the operation hits a known back-pressure ceiling (admission caps, gas spike) in which case pick a smaller number with the reason in the help text.

## Examples

### Bad

```
--car-store DIR     (required, no default)
--ipni-sample N     (required, must read docs to know if 100 is sane)
```

### Good

```
--car-store DIR     Where to cache assembled sub-piece CARs (default: enabled; --no-car-store to disable when disk is tight)
--ipni-sample N     CIDs to probe for IPNI announcement (default: 100; --ipni-all for full sweep)
```

## Why

A flag with no default forces every operator to think about something the maintainer already knows the answer to. Sample-100 is enough signal for a million-CID migration; once the cache lands it will be cheap insurance against source-gateway outages.
