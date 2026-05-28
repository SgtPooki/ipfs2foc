# Default Mainnet Network

**Trigger:** Adding network selection, chain config, contract clients, or any CLI flag, help text, or log line that depends on which Filecoin network the command is running against.

## Rule

- Default network is `mainnet`. Calibration is `--network calibration`. No other implicit fallback.
- Every command that touches chain state accepts `--network <mainnet|calibration>` and prints the selected network in its first log line.
- Import the chain definition from `@filoz/synapse-core/chains` (`mainnet` / `calibration`). Do not hardcode contract addresses, RPC URLs, or chain IDs.
- Do not infer the network from test data, dataset ID ranges, RPC URL host names, or `process.env.NODE_ENV`. The operator picks; the command obeys.
- Refuse to run if the operator passed both `--network` and a value that contradicts other inputs (e.g. a calibration `--rpc-url` with `--network mainnet`).

## Examples

### Bad

```ts
const network = process.env.NODE_ENV === 'production' ? 'mainnet' : 'calibration'
const rpc = network === 'mainnet' ? 'https://api.node.glif.io/' : 'https://api.calibration.node.glif.io/'
```

### Good

```ts
import { mainnet, calibration } from '@filoz/synapse-core/chains'

const network = (flags.network ?? 'mainnet') as 'mainnet' | 'calibration'
const chain = network === 'mainnet' ? mainnet : calibration
log(`network: ${network} (data set ${flags.dataSetId})`)
const client = createPublicClient({ chain, transport: http(flags['rpc-url']) })
```

## Why

A migration command that silently picks the wrong network can move real value or attempt to verify against a chain that does not hold the data. Defaulting to `mainnet` makes accidents conservative: an operator who forgets to set `--network calibration` for a test gets a clear error, not a silent move on the production chain.
