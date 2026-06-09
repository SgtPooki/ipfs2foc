# ipfs2foc

[![npm version](https://img.shields.io/npm/v/ipfs2foc.svg)](https://www.npmjs.com/package/ipfs2foc)
[![Node](https://img.shields.io/node/v/ipfs2foc.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Migrate already-pinned IPFS CIDs onto Filecoin Onchain Cloud (FOC) without
re-chunking.

Each original CID stays byte-for-byte intact and individually retrievable over
IPFS, while far fewer pieces are committed on-chain. The storage provider pulls
each object's bytes directly from a trustless IPFS gateway; your machine streams
each object once to compute its piece commitment and stores none of the payload.

To run a migration with nothing installed, use the browser console at
[sgtpooki.github.io/ipfs2foc](https://sgtpooki.github.io/ipfs2foc/).

## Install

```bash
npm install -g ipfs2foc      # the `ipfs2foc` command
# or run without installing:
npx ipfs2foc --help
```

Requires **Node 26+** (uses the built-in `node:sqlite`).

## Quickstart

```bash
ipfs2foc --help              # list commands
ipfs2foc probe --gateway https://trustless-gateway.link   # check a source
```

## Documentation

Full usage, prerequisites, the on-chain flow, and operational notes live in the
repository:

- [Project README](https://github.com/SgtPooki/ipfs2foc#readme) — install,
  quickstart, commands, troubleshooting, how it works.
- [`docs/`](https://github.com/SgtPooki/ipfs2foc/tree/main/docs) — tutorial,
  glossary, source/gateway notes, ingress, personas.

## License

[MIT](./LICENSE)
