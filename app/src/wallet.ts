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

/** Resolve a chain id to a known network label, or null if unrecognized. */
export function networkOf(chainId: number): NetworkKey | null {
  for (const [key, net] of Object.entries(NETWORKS)) {
    if (net.id === chainId) return key as NetworkKey
  }
  return null
}
