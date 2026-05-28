# Git Commit

**Trigger:** writing a commit message in this repo.

## Rule

- Conventional Commits prefix: one of `feat:`, `fix:`, `docs:`, `chore:`,
  `refactor:`, `perf:`, `test:`, `build:`, `ci:`, `style:`. Pick the one
  that matches the dominant intent of the diff.
- Active voice. Subject is what the change does, not what was done.
- Under 50 characters for the subject line. Hard limit.
- No body unless the change cannot be understood without one. If a body
  is needed, the diff is probably doing too much; consider splitting.
- Subject follows the same prose rules as `anti-ai-smell.md` and
  `documentation-voice.md`: no banned vocabulary, no contrastive
  em-dash sandwich construction, no private-conversation framing.
- No trailing period.

## Examples

### Bad

```
Updated some things in the report so it now does a better job of verifying that all the CIDs have been confirmed on chain and added a new flag for sampling.

This is a comprehensive refactor that leverages the new helpers from synapse-core. Additionally it removes the gateway probe.
```

### Good

```
feat: on-chain proof health and IPNI announcement check
```

```
fix: addStatus must check addMessageOk and piecesAdded
```

```
docs: drop mode a/b framing
```

## Why

A 50-character subject fits in `git log --oneline`, GitHub's commit list,
and rebase TODOs. A reader scanning `git log` should understand the
intent without expanding the body. Bodies that exist only to apologize
for the diff size are noise; split the diff instead.
