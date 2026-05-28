# AGENTS.md

Instructions for AI coding agents (Claude Code, Cursor, Copilot, Codex)
working in this repo. Skills under `skills/` are the source of truth; this
file is the index.

## When in doubt

- Read the skill before re-asking the operator.
- Read the source before asserting upstream behavior.
- Read the chain before trusting an HTTP probe.

## Read these every session

Before writing or editing files, load the skills in `skills/`. They are
plain Markdown; load the whole directory into context at session start.
They encode lessons the operator has explicitly surfaced. Re-litigating
any of them is not free work.

## Task → skills routing

When the next action lands in one of these surfaces, load the matched
skills first.

| Editing | Load first |
|---|---|
| `src/report.ts`, `src/pdp-verifier.ts` | `onchain-canonical-not-side-channel`, `addstatus-three-signals`, `memory-aware-scaling`, `sample-not-sweep-at-scale`, `validate-at-each-step` |
| `src/submit-pdp.ts`, `src/pdp.ts` | `addstatus-three-signals`, `validate-at-each-step`, `verify-actual-behavior`, `prefer-upstream-libraries` |
| `src/gateway.ts`, fetch / HTTP code | `prefer-head-over-get`, `sample-not-sweep-at-scale`, `onchain-canonical-not-side-channel` |
| `src/db.ts`, schema changes | `no-pre-release-migrations`, `memory-aware-scaling` |
| New CLI flag, env var, help text | `sensible-defaults`, `default-mainnet-network`, `no-internal-jargon-leakage` |
| `docs/**`, `README.md`, persistent docs | `documentation-voice`, `anti-ai-smell`, `no-vendor-leakage`, `no-internal-jargon-leakage` |
| GitHub issue body | `github-issue-structure`, `anti-ai-smell`, `no-vendor-leakage`, `documentation-voice` |
| Pull-request description | `github-pr-structure`, `anti-ai-smell`, `documentation-voice` |
| Commit message | `git-commit`, `anti-ai-smell` |
| Investigation / peer-review drafts | `research-folder-gitignored`, `no-internal-jargon-leakage`, `investigation-split` |

## Skill index

### Verification and integrity (foc-migrate / FOC specific)

- [`skills/verify-actual-behavior.md`](skills/verify-actual-behavior.md)
  Read source or run probes before asserting how an external API
  behaves.
- [`skills/onchain-canonical-not-side-channel.md`](skills/onchain-canonical-not-side-channel.md)
  Chain state is truth. IPFS gateway probes and SP HTTP status are
  supplementary at most.
- [`skills/validate-at-each-step.md`](skills/validate-at-each-step.md)
  Validate state transitions at the moment they happen, not only at
  `report` time.
- [`skills/addstatus-three-signals.md`](skills/addstatus-three-signals.md)
  Curio's `pdp.addStatus` carries `txStatus`, `addMessageOk`,
  `piecesAdded` as independent signals. Success requires all three.

### Code quality

- [`skills/prefer-upstream-libraries.md`](skills/prefer-upstream-libraries.md)
  Import ABI, addresses, helpers from `@filoz/synapse-core/*`. Do not
  redefine.
- [`skills/memory-aware-scaling.md`](skills/memory-aware-scaling.md)
  At million-CID scale, never materialize the full list to sample 100
  of it.
- [`skills/prefer-head-over-get.md`](skills/prefer-head-over-get.md)
  Use HTTP HEAD for existence/content-type probes.
- [`skills/sensible-defaults.md`](skills/sensible-defaults.md)
  Pick defaults that protect the most common operator. Names the
  repo-wide defaults (mainnet, cache on, sample 100, concurrency 4).
- [`skills/sample-not-sweep-at-scale.md`](skills/sample-not-sweep-at-scale.md)
  Default to stride sampling; gate full sweep behind `--all`.
- [`skills/default-mainnet-network.md`](skills/default-mainnet-network.md)
  Default network is `mainnet`. Commands accept `--network` and print
  the selected network. No silent inference.

### Project hygiene

- [`skills/no-vendor-leakage.md`](skills/no-vendor-leakage.md)
  Customer and vendor brand names never appear in committed files.
- [`skills/no-internal-jargon-leakage.md`](skills/no-internal-jargon-leakage.md)
  Investigation labels stay in `.research/`. User-facing docs use
  descriptive names.
- [`skills/research-folder-gitignored.md`](skills/research-folder-gitignored.md)
  Exploratory markdown goes in `.research/` (gitignored).
- [`skills/no-pre-release-migrations.md`](skills/no-pre-release-migrations.md)
  Extend `CREATE TABLE IF NOT EXISTS` directly. No ALTER scaffolding
  before a real release.

### Doc / issue / PR writing

- [`skills/documentation-voice.md`](skills/documentation-voice.md)
  Future-oriented, neutral upstream framing, verify before asserting,
  link instead of restate.
- [`skills/anti-ai-smell.md`](skills/anti-ai-smell.md)
  Banned words and structural anti-patterns for human prose.
- [`skills/github-issue-structure.md`](skills/github-issue-structure.md)
  Title + body shape for tracker issues.
- [`skills/github-pr-structure.md`](skills/github-pr-structure.md)
  Required `What changed`, optional verify/risks. 100–200 words.
- [`skills/investigation-split.md`](skills/investigation-split.md)
  Tracker issue plus linked detail doc when evidence is long.
- [`skills/git-commit.md`](skills/git-commit.md)
  Conventional prefix, active voice, under 50 characters, no body
  unless required.

## Operating defaults

- Default network: `mainnet`. Calibration is `--network calibration`.
- Push to `main`; no pull-request gate. Branch + merge + delete remote
  branch is fine.
- `node:sqlite` is the persistence layer. Node 26+.
- Anything investigation-shaped (peer-review prompts, design memos,
  scratch findings) goes in `.research/`. That directory is gitignored.
- User-facing docs live in `docs/`. Operator-facing CLI help and logs
  follow the same voice rules as `docs/`.
- Commit messages: see [`skills/git-commit.md`](skills/git-commit.md).
