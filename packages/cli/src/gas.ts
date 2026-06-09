/**
 * Network base-fee monitoring.
 *
 * Filecoin gas cost scales with the block base fee, and PDP transactions burn
 * large gas amounts, so a congested network multiplies cost sharply. The storage
 * provider submits and pays for the on-chain AddPieces, but a high base fee is
 * the signal to pause submitting new aggregates: it keeps the provider's commits
 * from stalling and keeps a migrator's own setup transactions (USDFC deposit,
 * operator approval) cheap.
 *
 * Read `baseFeePerGas` from the latest block, not `eth_gasPrice` (which blends
 * in a suggested tip and hides the base-fee signal). Units are attoFIL/gas; the
 * floor is 100.
 */

export const BASE_FEE_FLOOR = 100n

/** Default attoFIL/gas at which to pause submission. ~10000x floor. */
export const DEFAULT_MAX_BASE_FEE = 1_000_000n

export const RPC_URLS: Record<string, string> = {
  mainnet: 'https://api.node.glif.io/rpc/v1',
  calibration: 'https://api.calibration.node.glif.io/rpc/v1',
}

export type BaseFeeLevel = 'ok' | 'rising' | 'spike'

export interface BaseFeeReading {
  baseFee: bigint
  multipleOfFloor: number
  level: BaseFeeLevel
  /** Submission should pause while true. */
  pause: boolean
}

export function resolveRpcUrl(opts: { rpcUrl?: string; network?: string }): string {
  if (opts.rpcUrl != null && opts.rpcUrl !== '') {
    return opts.rpcUrl
  }
  const network = opts.network ?? 'mainnet'
  const url = RPC_URLS[network]
  if (url == null) {
    throw new Error(`unknown network "${network}" (use mainnet|calibration or --rpc-url)`)
  }
  return url
}

/** Read the latest block base fee (attoFIL/gas). */
export async function getBaseFee(rpcUrl: string, signal?: AbortSignal): Promise<bigint> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_getBlockByNumber',
      params: ['latest', false],
      id: 1,
    }),
    signal,
  })
  if (!res.ok) {
    throw new Error(`RPC ${rpcUrl} returned HTTP ${res.status}`)
  }
  const body = (await res.json()) as { result?: { baseFeePerGas?: string }; error?: { message?: string } }
  if (body.error != null) {
    throw new Error(`RPC error: ${body.error.message ?? 'unknown'}`)
  }
  const hex = body.result?.baseFeePerGas
  if (hex == null) {
    throw new Error('RPC response missing baseFeePerGas')
  }
  return BigInt(hex)
}

/**
 * Classify a base fee against the pause threshold. Below a tenth of the
 * threshold is `ok`; below the threshold is `rising`; at or above it is `spike`
 * and submission should pause.
 */
export function classifyBaseFee(baseFee: bigint, maxBaseFee = DEFAULT_MAX_BASE_FEE): BaseFeeReading {
  const level: BaseFeeLevel = baseFee >= maxBaseFee ? 'spike' : baseFee * 10n >= maxBaseFee ? 'rising' : 'ok'
  return {
    baseFee,
    multipleOfFloor: Number(baseFee / BASE_FEE_FLOOR),
    level,
    pause: level === 'spike',
  }
}
