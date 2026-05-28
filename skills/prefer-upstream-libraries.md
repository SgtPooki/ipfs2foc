# Prefer Upstream Libraries

**Trigger:** Adding code that talks to a contract or external API for which the project already depends on a typed client.

## Rule

- Import ABIs, addresses, and helpers from the existing typed dependency.
- Do not hand-roll ABI snippets, hex selectors, or contract address constants.
- If the upstream export is missing: open an upstream issue if you can, otherwise note the gap in `.research/upstream-gaps.md` and use a minimal local shim that imports the upstream ABI rather than redefining it.
- Check the package's subpath exports before writing wrappers.

## Examples

### Bad

```ts
const PDP_ABI = [{ name: 'dataSetLive', type: 'function', inputs: [...] }]
const PDP_ADDRESS = '0x...'
const result = await publicClient.readContract({ abi: PDP_ABI, address: PDP_ADDRESS, functionName: 'dataSetLive', args: [id] })
```

### Good

```ts
import { dataSetLive, getActivePieces, getNextChallengeEpoch, getActivePieceCount } from '@filoz/synapse-core/pdp-verifier'
import { PDP_ABI } from '@filoz/synapse-core/abis'
import { mainnet } from '@filoz/synapse-core/chains'

const live = await dataSetLive(publicClient, id)
```

## Why

Parallel ABI snippets drift from on-chain reality when the contract upgrades. The typed helper carries the right address per chain and the right return shape, so the call site stays correct without manual sync.
