# Contributing

Thanks for helping improve ipfs2foc. This repo is small; the loop is short.

## Dev loop

Development uses [pnpm](https://pnpm.io) (Corepack picks the version from
`package.json`'s `packageManager` field).

```bash
pnpm install
pnpm lint            # biome check
pnpm typecheck       # tsc --noEmit
pnpm test            # node --test
pnpm build           # compile to dist/ (what gets published)
```

ipfs2foc runs on **Node 26+** and uses the built-in `node:sqlite`. During
development, run the CLI straight from source — `node packages/cli/src/index.ts <command>` —
since Node strips the TypeScript types at runtime. The published package ships
compiled JS from `dist/` (Node refuses to strip types under `node_modules`).

Keep `pnpm lint`, `pnpm typecheck`, and the test suite green before pushing.
Tests live under `test/` and drive control flow with injectable dependencies
rather than live network calls; match that pattern when adding coverage.

## Conventions

`AGENTS.md` and the skills under `skills/` are the source of truth for code,
docs, and commit style. The ones you will reach for most:

- **Commits** — Conventional Commits prefix, active voice, under 50 characters,
  no body unless required (`skills/git-commit.md`).
- **Docs and prose** — describe the system as it is now, verify before
  asserting, link instead of restating (`skills/documentation-voice.md`,
  `skills/anti-ai-smell.md`).
- **Defaults and behavior** — `mainnet` is the default network; CLI flags state
  their default in `--help` (`skills/default-mainnet-network.md`,
  `skills/sensible-defaults.md`).

Verify CLI commands and flags against `ipfs2foc --help` rather than from memory;
docs that lag the binary are a bug.

## Workflow

Push to `main`; there is no pull-request gate. Branch, merge, and delete the
remote branch is fine for larger changes. Exploratory notes go under `.research/`
(gitignored) and never land in a commit.
</content>
