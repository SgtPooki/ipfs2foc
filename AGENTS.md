# AGENTS.md

Instructions for AI coding agents (Claude Code, Cursor, Copilot, Codex)
working in this repo. Skills under `skills/` are the source of truth; this
file is the index.

## When in doubt

- Read the skill before re-asking the operator.
- Read the source before asserting upstream behavior.
- Read the chain before trusting an HTTP probe.
- If you find yourself wanting to add a "just-in-case" guard, stop and
  read the source first (see `no-defense-in-depth-as-ignorance-mask`).

## How to use this file

Load this `AGENTS.md` at session start. Do **not** load every skill in
`skills/`; that wastes context and trains agents to ignore the lot.
Instead, match the task you are about to perform to the routing table
below and load only the matching skills. Load the full skill index when
the task does not match any row, or when scope is unclear.

## Task → skills routing

When the next action lands in one of these surfaces, load the matched
skills first.

| Editing | Load first |
|---|---|
| `src/report.ts`, `src/pdp-verifier.ts` | `onchain-canonical-not-side-channel`, `memory-aware-scaling`, `sample-not-sweep-at-scale`, `validate-at-each-step`, `prefer-upstream-libraries` |
| `src/submit-pdp.ts`, `src/pdp.ts` | `addstatus-three-signals`, `validate-at-each-step`, `verify-actual-behavior`, `prefer-upstream-libraries`, `no-defense-in-depth-as-ignorance-mask` |
| `src/create-data-set.ts` | `default-mainnet-network`, `prefer-upstream-libraries`, `validate-at-each-step` |
| `src/gas.ts` | `default-mainnet-network`, `prefer-upstream-libraries` |
| `src/migrate.ts`, `src/runner.ts`, `src/aggregate.ts`, `src/piece.ts` | `sensible-defaults`, `memory-aware-scaling`, `verify-actual-behavior` |
| `src/gateway.ts`, `src/redirect-server*.ts`, fetch / HTTP code | `prefer-head-over-get`, `sample-not-sweep-at-scale`, `onchain-canonical-not-side-channel` |
| `src/db.ts`, schema changes | `no-pre-release-migrations`, `memory-aware-scaling` |
| `src/index.ts`, CLI flags, env vars, help text, `src/server.ts` | `sensible-defaults`, `default-mainnet-network`, `memory-aware-scaling`, `no-internal-jargon-leakage`, `anti-ai-smell` |
| `src/metrics.ts`, `src/util.ts` | `no-internal-jargon-leakage`, `anti-ai-smell`, `documentation-voice` |
| `src/piece-aggregate.ts` | `sensible-defaults`, `memory-aware-scaling`, `verify-actual-behavior` |
| `src/analyze.ts` | `sensible-defaults`, `sample-not-sweep-at-scale`, `memory-aware-scaling`, `default-mainnet-network`, `prefer-head-over-get`, `no-internal-jargon-leakage`, `anti-ai-smell` |
| `test/**` | `verify-actual-behavior`, `no-vendor-leakage`, `no-internal-jargon-leakage` |
| `package.json` dep add / SDK swap | `prefer-upstream-libraries`, `verify-actual-behavior` |
| `docs/**`, `README.md`, persistent docs | `documentation-voice`, `anti-ai-smell`, `no-vendor-leakage`, `no-internal-jargon-leakage` |
| GitHub issue body | `github-issue-structure`, `anti-ai-smell`, `no-vendor-leakage`, `documentation-voice` |
| Pull-request description | `github-pr-structure`, `anti-ai-smell`, `documentation-voice` |
| Commit message | `git-commit`, `anti-ai-smell` |
| `.research/**` writes | `research-folder-gitignored`, `no-internal-jargon-leakage` |

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
- [`skills/no-defense-in-depth-as-ignorance-mask.md`](skills/no-defense-in-depth-as-ignorance-mask.md)
  A "just in case" guard is a red flag for not understanding the
  external behavior. Read the source first.

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
  repo-wide defaults; see the skill for the canonical list.
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

Repo facts not covered by a skill:

- Push to `main`; no pull-request gate. Branch + merge + delete remote
  branch is fine.
- `node:sqlite` is the persistence layer. Node 26+.
- User-facing docs live in `docs/`. Operator-facing CLI help and logs
  follow the same voice rules as `docs/`.

For everything else, the skill is the source of truth:

- Network defaults: see [`skills/default-mainnet-network.md`](skills/default-mainnet-network.md).
- Cache, sample size, concurrency: see [`skills/sensible-defaults.md`](skills/sensible-defaults.md).
- Investigation drafts under `.research/`: see [`skills/research-folder-gitignored.md`](skills/research-folder-gitignored.md).
- Commit messages: see [`skills/git-commit.md`](skills/git-commit.md).
