# Sensible Defaults

**Trigger:** Adding a new CLI flag, env var, or config knob.

## Rule

- Pick the default that produces the safest outcome for the most common operator. Opt-in flags toggle the expensive or destructive path, not the safe path.
- State the default value in `--help` text on the same line as the flag.
- Repo-specific defaults that must hold across new commands:
  - **Network:** `mainnet`. Calibration is `--network calibration`.
  - **Cache:** on. Cache flag name in this repo is `--car-store <dir>` (see `docs/personas.md`); disable with `--no-car-store` when disk is tight.
  - **Sample size for verify / audit:** `100`. Full sweep is `--all`.
  - **Concurrency on fan-out HTTP/RPC:** `4`. Higher values are opt-in via `--concurrency`.

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

A flag with no default forces every operator to think about something the maintainer already knows the answer to. Cache-on is cheap insurance against source gateway outages; sample-100 is enough signal for a million-CID migration.
