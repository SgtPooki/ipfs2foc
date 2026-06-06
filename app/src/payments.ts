// Read-only payment-readiness checks for the signing flow (#23).
//
// FWSS reverts data set creation unless the payer has deposited USDFC into
// Filecoin Pay and approved FilecoinWarmStorageService as a payments operator
// (see README — Network gas and payments). These reads let the wallet panel
// say WHY signing is not available before any signing exists: everything here
// goes through a public RPC with the connected address as a read-only
// account — no wallet calls, no signatures.
//
// The synapse stack is imported lazily: it is only needed once a wallet is
// connected, and it should not weigh down first paint.
import type { NetworkKey } from './wallet.ts'

/** Public RPC per network — same defaults the CLI resolves (src/gas.ts). */
const RPC_URLS: Record<NetworkKey, string> = {
  mainnet: 'https://api.node.glif.io/rpc/v1',
  calibration: 'https://api.calibration.node.glif.io/rpc/v1',
}

export interface PaymentsStatus {
  /** Native FIL balance of the wallet (attoFIL). */
  fil: bigint
  /** USDFC sitting in the wallet (base units, 18 decimals). */
  walletUsdfc: bigint
  /** USDFC deposited into Filecoin Pay. */
  depositedUsdfc: bigint
  /** Deposited USDFC not currently locked up by payment rails. */
  availableUsdfc: bigint
  /** FilecoinWarmStorageService approved as a payments operator. */
  operatorApproved: boolean
}

/** True when the wallet can create a data set without an on-chain revert. */
export function readyToSign(s: PaymentsStatus): boolean {
  return s.operatorApproved && s.availableUsdfc > 0n
}

export async function readPaymentsStatus(address: `0x${string}`, network: NetworkKey): Promise<PaymentsStatus> {
  const [{ PaymentsService }, { calibration, mainnet, TOKENS }, { createClient, http }] = await Promise.all([
    import('@filoz/synapse-sdk/payments'),
    import('@filoz/synapse-sdk'),
    import('viem'),
  ])
  const chain = network === 'mainnet' ? mainnet : calibration
  // Read-only client: the address is just the subject of the reads.
  const client = createClient({ account: address, chain, transport: http(RPC_URLS[network]) })
  const payments = new PaymentsService({ client })

  const [fil, walletUsdfc, account, approval] = await Promise.all([
    payments.walletBalance(),
    payments.walletBalance({ token: TOKENS.USDFC }),
    payments.accountInfo(),
    // Operator defaults to the network's FilecoinWarmStorageService address.
    payments.serviceApproval(),
  ])

  return {
    fil,
    walletUsdfc,
    depositedUsdfc: account.funds,
    availableUsdfc: account.availableFunds,
    operatorApproved: approval.isApproved,
  }
}

/** Format a 18-decimal token amount for the panel: trimmed, 4 fractional digits. */
export function fmtToken(amount: bigint, symbol: string): string {
  const whole = amount / 10n ** 18n
  const frac = (amount % 10n ** 18n) / 10n ** 14n
  return `${whole}.${frac.toString().padStart(4, '0')} ${symbol}`
}
