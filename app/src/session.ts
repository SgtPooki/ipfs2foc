// Session-key lifecycle for the signing flow (#23): grant, resume, extend,
// revoke. Reviewed design and accepted findings live with the issue; the
// invariants encoded here:
//
// - The grant is MINIMAL: CreateDataSet + AddPieces only. Both
//   `SessionKey.login` and `getExpirations` silently default to ALL FOUR FWSS
//   permissions (including removals and data set deletion) when the
//   permissions array is omitted — every call below passes
//   SESSION_KEY_PERMISSIONS explicitly. The downstream Synapse construction
//   must use `new Synapse({ client, sessionClient })`; `Synapse.create()`
//   rejects keys that lack the full default permission set.
// - Expiry is always explicit (the SDK default is one hour) and chain reads
//   are authoritative: resume validates BOTH permissions via getExpirations
//   and discards the stored key if either is revoked or expired.
// - Revoke is chain-first: the local key is wiped only after the revoke
//   transaction confirms. A rejected revoke keeps the key so the UI can
//   retry — wiping early would leave an authorization alive on chain with no
//   way to revoke it from the app.
// - Presigns are consumed by the provider on-chain LATER (pulls can take
//   hours): no new presign batch should be issued within
//   PRESIGN_SAFETY_MARGIN_SECONDS of expiry. Extend-in-place re-logins the
//   SAME session address, so stored material never changes.
import type { SynapseFromClientOptions } from '@filoz/synapse-sdk'
import type { Hex } from 'viem'
import { loadSessionKey, saveSessionKey, updateSessionExpiry, wipeSessionKey } from './session-store.ts'
import type { NetworkKey, WalletState } from './wallet.ts'

/** The session-key-backed viem client Synapse signs FWSS typed-data with. */
export type SessionClient = NonNullable<SynapseFromClientOptions['sessionClient']>

/**
 * Selectable grant durations. Longer windows get blunter risk copy in the UI.
 * Every option must exceed PRESIGN_SAFETY_MARGIN_SECONDS by a working margin —
 * a grant at or under it could never issue a presign.
 */
export const SESSION_DURATIONS = [
  { label: '24 hours', seconds: 86_400n },
  { label: '3 days', seconds: 259_200n },
  { label: '7 days', seconds: 604_800n },
] as const

export const DEFAULT_SESSION_DURATION_SECONDS = 86_400n

/**
 * Stop issuing new presign batches when the session has less than this long
 * to live: the provider submits AddPieces on-chain after pulling, and the
 * authorization is checked then, not at presign time.
 */
export const PRESIGN_SAFETY_MARGIN_SECONDS = 3_600n

export interface SessionState {
  sessionAddress: `0x${string}`
  /** Unix seconds — the smaller of the two permission expiries, read on chain. */
  expiresAt: bigint
  /** Signs FWSS typed-data in place of the wallet. Pass as Synapse sessionClient. */
  sessionClient: SessionClient
  /**
   * Raw key material — carried so a trusted LOCAL daemon can be handed the
   * session (#25: the serve daemon signs presigns and drives pull/add). Kept
   * on the state (not just in IndexedDB) because storage writes silently
   * no-op in private windows. Never log it; the hosted flow never reads it.
   */
  privateKey: Hex
}

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000))

export function sessionUsable(s: Pick<SessionState, 'expiresAt'>): boolean {
  return s.expiresAt > nowSeconds()
}

/** True while new presign batches may still be issued (expiry margin honored). */
export function sessionCanPresign(s: Pick<SessionState, 'expiresAt'>): boolean {
  return s.expiresAt - nowSeconds() > PRESIGN_SAFETY_MARGIN_SECONDS
}

async function deps() {
  const [SessionKey, { calibration, mainnet }, viem, accounts] = await Promise.all([
    import('@filoz/synapse-core/session-key'),
    import('@filoz/synapse-sdk'),
    import('viem'),
    import('viem/accounts'),
  ])
  return { SessionKey, chains: { calibration, mainnet }, viem, accounts }
}

/** The minimal permission pair — passed explicitly to every registry call. */
async function sessionPermissions() {
  const { CreateDataSetPermission, AddPiecesPermission } = await import('@filoz/synapse-core/session-key')
  return [CreateDataSetPermission, AddPiecesPermission]
}

export function walletChainClient(
  wallet: WalletState,
  network: NetworkKey,
  viem: Awaited<ReturnType<typeof deps>>['viem'],
  chains: Awaited<ReturnType<typeof deps>>['chains']
) {
  // The connect-time client carries no chain; registry writes simulate against
  // one, so rebuild a wallet client bound to the active network.
  const provider = (globalThis as { ethereum?: { request: (a: unknown) => Promise<unknown> } }).ethereum
  if (provider == null) throw new Error('wallet provider unavailable')
  return viem.createWalletClient({
    account: wallet.address,
    chain: chains[network],
    transport: viem.custom(provider as never),
  })
}

/**
 * Generate a fresh session key, authorize it on-chain (one wallet
 * transaction), persist it encrypted, and return the live session.
 */
export async function grantSession(
  wallet: WalletState,
  network: NetworkKey,
  durationSeconds: bigint,
  onTxHash?: (hash: string) => void
): Promise<SessionState> {
  const { SessionKey, chains, viem, accounts } = await deps()
  const permissions = await sessionPermissions()
  const privateKey = accounts.generatePrivateKey()
  const sessionAddress = accounts.privateKeyToAccount(privateKey).address
  const expiresAt = nowSeconds() + durationSeconds

  const client = walletChainClient(wallet, network, viem, chains)
  await SessionKey.loginSync(client, {
    address: sessionAddress,
    permissions,
    expiresAt,
    onHash: onTxHash,
  })

  await saveSessionKey({
    root: wallet.address,
    chainId: chains[network].id,
    privateKey,
    sessionAddress,
    expiresAt,
  })
  return buildSession(privateKey, sessionAddress, expiresAt, wallet.address, network)
}

/**
 * Restore the stored session for this wallet+network, validating BOTH
 * permissions on chain. Returns null (and wipes the dead record) when the
 * authorization is gone or expired.
 */
export async function resumeSession(wallet: WalletState, network: NetworkKey): Promise<SessionState | null> {
  const { SessionKey, chains, viem } = await deps()
  const permissions = await sessionPermissions()
  const chainId = chains[network].id
  const stored = await loadSessionKey({ root: wallet.address, chainId })
  if (stored == null) return null

  const readClient = viem.createClient({ chain: chains[network], transport: viem.http() })
  const expirations = await SessionKey.getExpirations(readClient, {
    address: wallet.address,
    sessionKeyAddress: stored.sessionAddress,
    permissions,
  })
  const expiries = permissions.map((p) => expirations[p] ?? 0n)
  const effective = expiries.reduce((a, b) => (a < b ? a : b))
  if (effective <= nowSeconds()) {
    await wipeSessionKey({ root: wallet.address, chainId })
    return null
  }
  return buildSession(stored.privateKey, stored.sessionAddress, effective, wallet.address, network)
}

/**
 * Extend the CURRENT session key's authorization (same address, new expiry).
 * One wallet transaction; stored key material is unchanged.
 */
export async function extendSession(
  wallet: WalletState,
  network: NetworkKey,
  session: SessionState,
  durationSeconds: bigint,
  onTxHash?: (hash: string) => void
): Promise<SessionState> {
  const { SessionKey, chains, viem } = await deps()
  const permissions = await sessionPermissions()
  const expiresAt = nowSeconds() + durationSeconds
  const client = walletChainClient(wallet, network, viem, chains)
  await SessionKey.loginSync(client, { address: session.sessionAddress, permissions, expiresAt, onHash: onTxHash })
  await updateSessionExpiry({ root: wallet.address, chainId: chains[network].id, expiresAt })
  return { ...session, expiresAt }
}

/**
 * Revoke the session on-chain, then wipe local material. Throws WITHOUT
 * wiping when the transaction is rejected or fails — the key must remain
 * available for a retry while its authorization is still live.
 */
export async function revokeSession(
  wallet: WalletState,
  network: NetworkKey,
  session: SessionState,
  onTxHash?: (hash: string) => void
): Promise<void> {
  const { SessionKey, chains, viem } = await deps()
  const permissions = await sessionPermissions()
  const client = walletChainClient(wallet, network, viem, chains)
  await SessionKey.revokeSync(client, { address: session.sessionAddress, permissions, onHash: onTxHash })
  await wipeSessionKey({ root: wallet.address, chainId: chains[network].id })
}

async function buildSession(
  privateKey: Hex,
  sessionAddress: `0x${string}`,
  expiresAt: bigint,
  root: `0x${string}`,
  network: NetworkKey
): Promise<SessionState> {
  const { SessionKey, chains } = await deps()
  const sessionKey = SessionKey.fromSecp256k1({ privateKey, root, chain: chains[network] })
  return { sessionAddress, expiresAt, sessionClient: sessionKey.client, privateKey }
}
