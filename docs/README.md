# ipfs2foc documentation

Organized by [Diátaxis](https://diataxis.fr/) — four kinds of documentation,
each answering a different need. Start with the tutorial if you are new; reach
for how-to guides and reference once you are running real migrations.

## Tutorials — learning by doing

- [Your first migration on calibration](tutorial-first-migration.md) — one CID
  end-to-end on the testnet, on rails, with a checkpoint at every step.

## How-to guides — getting a specific job done

- [Migrate in the browser](browser-console.md) — the hosted console: paste
  CIDs, get commitments, and submit to providers with a scoped signing
  session. No install, no key material on the page.
- [Migrate with the local console](local-console.md) — the same console served
  by `ipfs2foc serve`: server-side commP, assembled pieces, and wallet-signed
  submission that survives a closed tab. When to move here from the hosted
  console, and how a run carries over.
- [Operator profiles](personas.md) — map disk, bandwidth, and time budgets to
  `--max-in-flight`, `--piece-size`, and ingress choices, with per-profile
  failure modes and recovery.
- [Choosing a source gateway](sources.md) — per-provider notes and the `probe`
  check for deterministic trustless CARs.
- [Public ingress for provider pulls](ingress.md) — Cloudflare quick tunnel,
  Tailscale Funnel, or a VPS reverse proxy, for `serve` or `redirect-serve`,
  and the public-HTTPS shape the provider validates.
- [Recover a stuck run](../README.md#recovery-commands) — re-arm failed or
  unconfirmed aggregates.

## Reference — the facts

- [Command reference](../README.md#commands) — every subcommand, its flags, and
  their defaults. Verify against `ipfs2foc --help`.
- [Glossary](glossary.md) — operator-level definitions for PieceCID v2, PDP
  pull, aggregate piece commitment, FWSS, and the other protocol terms.

## Explanation — how and why

- [How a migration lands on chain](onchain.md) — the invariants under every
  flow: the CAR bytes as the commitment's definition, piece-CID determinism
  across providers, the AddPieces event cap, committed vs proven, and
  reading chain state over receipts. Start here if you are integrating
  against FOC with your own tooling.
- [How it works](../README.md#how-it-works) — the commP → pack → pull →
  aggregate-add pipeline, the redirect, and the aggregate root.
- [Network gas and payments](../README.md#network-gas-and-payments) — which
  wallet spends what, in which currency.
- [Scope and limits](../README.md#scope-and-limits) — sub-piece and aggregate
  size bounds, determinism, and the all-or-nothing aggregate rule.
- [Security](../SECURITY.md) — signing-key handling and what the key authorizes.
</content>
