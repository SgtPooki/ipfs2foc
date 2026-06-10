// BYOW wallet connect over an injected EIP-1193 provider. The prepare-migration
// flow reads the account and chain only; it signs nothing. Wallet-signed
// createDataSet / AddPieces (via the Synapse SDK with a viem wallet client) are
// not wired here.
import { createWalletClient, custom, type WalletClient } from 'viem'

/** Filecoin network chain ids. Calibration is the testnet default for the hosted app. */
export const NETWORKS = {
  calibration: { id: 314159, label: 'Filecoin Calibration', explorer: 'https://calibration.filfox.info' },
  mainnet: { id: 314, label: 'Filecoin Mainnet', explorer: 'https://filfox.info' },
} as const

export type NetworkKey = keyof typeof NETWORKS

export interface WalletState {
  address: `0x${string}`
  chainId: number
  client: WalletClient
}

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, handler: (...args: unknown[]) => void): void
}

export function injectedProvider(): Eip1193Provider | null {
  const eth = (globalThis as { ethereum?: Eip1193Provider }).ethereum
  return eth ?? null
}

export async function connectWallet(): Promise<WalletState> {
  const provider = injectedProvider()
  if (provider == null) {
    throw new Error('no injected wallet found — install MetaMask or another EIP-1193 wallet')
  }
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as `0x${string}`[]
  if (accounts.length === 0) throw new Error('wallet returned no accounts')
  const chainIdHex = (await provider.request({ method: 'eth_chainId' })) as string
  const client = createWalletClient({ account: accounts[0], transport: custom(provider) })
  return { address: accounts[0], chainId: Number.parseInt(chainIdHex, 16), client }
}

/** Network params for `wallet_addEthereumChain` (most wallets ship neither Filecoin chain). */
const CHAIN_PARAMS: Record<
  NetworkKey,
  {
    chainId: string
    chainName: string
    nativeCurrency: { name: string; symbol: string; decimals: number }
    rpcUrls: string[]
    blockExplorerUrls: string[]
  }
> = {
  calibration: {
    chainId: `0x${NETWORKS.calibration.id.toString(16)}`,
    chainName: 'Filecoin Calibration',
    nativeCurrency: { name: 'testnet FIL', symbol: 'tFIL', decimals: 18 },
    rpcUrls: ['https://api.calibration.node.glif.io/rpc/v1'],
    blockExplorerUrls: ['https://calibration.filfox.info'],
  },
  mainnet: {
    chainId: `0x${NETWORKS.mainnet.id.toString(16)}`,
    chainName: 'Filecoin Mainnet',
    nativeCurrency: { name: 'FIL', symbol: 'FIL', decimals: 18 },
    rpcUrls: ['https://api.node.glif.io/rpc/v1'],
    blockExplorerUrls: ['https://filfox.info'],
  },
}

/**
 * Ask the wallet to switch to the given network, adding it first if the
 * wallet doesn't know it (EIP-3326 switch, falling back to EIP-3085 add on the
 * 4902 "unrecognized chain" error). Resolves once the wallet has switched.
 */
export async function switchToNetwork(network: NetworkKey): Promise<void> {
  const params = CHAIN_PARAMS[network]
  const provider = injectedProvider()
  if (provider == null) throw new Error('no injected wallet found')
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: params.chainId }],
    })
  } catch (err) {
    // 4902: chain not added yet. Some wallets nest it under .code -32603.
    const code = (err as { code?: number }).code
    if (code === 4902 || code === -32603) {
      await provider.request({ method: 'wallet_addEthereumChain', params: [params] })
    } else {
      throw err
    }
  }
}

export async function switchToCalibration(): Promise<void> {
  return switchToNetwork('calibration')
}

/** Re-read the connected account + chain (after a network switch). */
export async function refreshWallet(): Promise<WalletState> {
  return connectWallet()
}

/** Resolve a chain id to a known network label, or null if unrecognized. */
export function networkOf(chainId: number): NetworkKey | null {
  for (const [key, net] of Object.entries(NETWORKS)) {
    if (net.id === chainId) return key as NetworkKey
  }
  return null
}
