# Security

ipfs2foc signs on-chain transactions and spends real funds. This document
covers how it handles the signing key, what that key can authorize, and how to
report a vulnerability.

## Reporting a vulnerability

Report privately through GitHub's
[security advisories](https://github.com/SgtPooki/ipfs2foc/security/advisories/new)
for this repository. Do not open a public issue for an exploitable flaw. Expect
an initial response within a few days.

## The signing key

`create-data-set` and `pdp-submit` read the signer from the `PRIVATE_KEY`
environment variable (`0x` + 64 hex). The key is passed to viem's
`privateKeyToAccount` and used to sign locally; it is not written to the SQLite
database (the schema stores only CIDs, piece commitments, and aggregate
lifecycle — see [State](README.md#state)) and the tool does not print it. Only
the resulting signatures and signed transactions leave the process.

Operator guidance:

- **Use a dedicated migration wallet.** Fund it with only the FIL and USDFC a
  run needs. A migration key does not need to hold long-term reserves.
- **Keep the key out of shell history and version control.** Prefer
  `source .env` from a file that is in `.gitignore`, or a secrets manager, over
  inlining the key on the command line.
- **Scope by network.** The default network is `mainnet`, which spends real
  funds. Rehearse a run end-to-end with `--network calibration` first.

## What the key authorizes

The same key signs every step, so anyone holding it can spend on the migrator's
behalf:

- **FIL** from the migrator's wallet for its own setup transactions: the USDFC
  ERC-20 approve, the FilecoinPay deposit, and the FilecoinWarmStorageService
  operator approval.
- **USDFC** committed as storage payment. `create-data-set` opens a payment rail
  and locks the minimum lockup plus a one-time sybil fee; AddPieces raises the
  locked amount as the data set grows.
- **EIP-712 authorizations** carried in each call's `extraData`. The storage
  provider submits and pays FIL gas for createDataSet, AddPieces, and proof of
  possession; the migrator's signature authorizes them. See
  [Network gas and payments](README.md#network-gas-and-payments).

## Data handling

ipfs2foc streams each object once to compute its piece commitment and stores no
payload bytes. The SQLite database holds CIDs, piece commitments, the aggregate
plan, and per-aggregate lifecycle (data set id, transaction hash). The
`redirect-serve` HTTP server answers 302 redirects to gateway CARs (passthrough
sub-pieces) or byte-serves assembled CAR files (multi-asset sub-pieces) from
`--car-store`; it carries no key material.
</content>
