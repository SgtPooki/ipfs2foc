# No Internal Jargon Leakage

**Trigger:** Writing any user-facing surface (docs, README, code symbols, filenames, CLI flag names, help text, log strings) that names a design decision.

## Rule

- Use descriptive names for code paths: "cached sub-piece path", "stream-assemble path".
- Investigation labels ("option A", "option C", "the β path", "v2 prepend") stay in `.research/`.
- If a doc reader cannot map the label to behavior without reading the investigation, rename it.
- Code symbols follow the same rule: `assembleFromCache()` beats `optionAPath()`.

## Examples

### Bad

```md
We picked option C over option A because the v2 prepend was cheaper.
```

### Good

```md
We assemble pieces from the local cache instead of re-streaming from the source gateway; this avoids a second egress per migration.
```

## Why

Investigation labels are scaffolding for a conversation that already happened. Readers of the shipped doc were not in that conversation, and the labels carry no meaning for them.
