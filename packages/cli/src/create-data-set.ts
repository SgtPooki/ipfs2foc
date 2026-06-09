/**
 * Provision a new FilecoinWarmStorageService data set on a chosen provider.
 *
 * Resolves the provider's `serviceURL` and `payee` from the SP registry, signs
 * the FWSS `CreateDataSet` typed-data with the migrator's key, and POSTs the
 * create call to `/pdp/data-sets`. The data set is created with
 * `withIPFSIndexing` in its metadata so each parked CAR's blocks are indexed
 * and the original CIDs stay retrievable from the IPFS network.
 *
 * The migrator's wallet must already hold sufficient USDFC and have approved
 * FilecoinWarmStorageService as a payments operator (see README — Network gas
 * and payments). FWSS reverts data set creation otherwise.
 */

import { createDataSet, waitForCreateDataSet } from '@filoz/synapse-core/sp'
import { calibration, mainnet } from '@filoz/synapse-sdk'
import { SPRegistryService } from '@filoz/synapse-sdk/sp-registry'
import { type Account, type Chain, createWalletClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { resolveRpcUrl } from './gas.ts'
import { explorerDataSetUrl } from './pdp-verifier.ts'
import { log } from './util.ts'

export interface CreateDataSetOptions {
  privateKey: Hex
  network: 'calibration' | 'mainnet'
  rpcUrl?: string
  providerId: bigint
  /** Enable filbeam CDN for this data set. */
  cdn?: boolean
  /** Wall-clock timeout for the create-tx confirmation, in milliseconds. */
  timeoutMs?: number
}

export interface CreateDataSetResult {
  dataSetId: number
  txHash: string
  serviceURL: string
  payee: string
}

export async function runCreateDataSet(opts: CreateDataSetOptions): Promise<CreateDataSetResult> {
  const rpcUrl = resolveRpcUrl({ rpcUrl: opts.rpcUrl, network: opts.network })
  const chain: Chain = opts.network === 'mainnet' ? mainnet : calibration
  const account: Account = privateKeyToAccount(opts.privateKey)
  const client = createWalletClient({ account, transport: http(rpcUrl), chain })

  const registry = new SPRegistryService({ client })
  const provider = await registry.getProvider({ providerId: opts.providerId })
  if (provider == null) {
    throw new Error(`provider ${opts.providerId} not found in SP registry on ${opts.network}`)
  }
  const serviceURL = provider.pdp.serviceURL
  const payee = provider.payee
  log(`Provider ${opts.providerId} -> ${serviceURL} (payee ${payee})`)

  const { txHash, statusUrl } = await createDataSet(client, {
    serviceURL,
    payee,
    cdn: opts.cdn === true,
    metadata: { withIPFSIndexing: '' },
  })
  log(`createDataSet tx ${txHash}; polling ${statusUrl}`)

  const success = await waitForCreateDataSet({ statusUrl, timeout: opts.timeoutMs })
  const dataSetId = Number(success.dataSetId)
  log(`data set ${dataSetId} created -> ${explorerDataSetUrl(opts.network, dataSetId)}`)
  return { dataSetId, txHash, serviceURL, payee }
}
