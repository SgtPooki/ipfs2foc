/**
 * Session-key signing for the serve daemon (#25): the browser wallet signs a
 * scoped on-chain grant (CreateDataSet + AddPieces, explicit expiry) and hands
 * the session key to this process, which then drives the existing PDP submit
 * machine without PRIVATE_KEY.
 *
 * Invariants (mirrors app/src/session.ts — both sides must agree):
 * - Permissions are MINIMAL and passed explicitly to every registry call;
 *   omitting them defaults to all four FWSS permissions.
 * - Synapse is built via the CONSTRUCTOR, `new Synapse({ client,
 *   sessionClient })`. `Synapse.create()` rejects scoped session keys.
 * - The `client` passed to Synapse carries ONLY the root (payer) address over
 *   plain http — it never signs. Everything that signs goes through the
 *   sessionClient; the provider submits (and pays for) the on-chain txs. Any
 *   future code path that tries to sign with `synapse.client` fails at
 *   runtime — keep signing on the session side.
 * - The chain is canonical for expiry: when the cached expiry enters the
 *   presign safety margin mid-run, re-read getExpirations before blocking —
 *   an operator who extended the session in the browser un-blocks a live run
 *   with no other action.
 */

import * as SessionKey from '@filoz/synapse-core/session-key'
import { createDataSet, waitForCreateDataSet } from '@filoz/synapse-core/sp'
import { calibration, mainnet, Synapse } from '@filoz/synapse-sdk'
import { SPRegistryService } from '@filoz/synapse-sdk/sp-registry'
import { createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { MigrationDB, SessionKeyRow } from './db.ts'
import { PdpClient } from './pdp.ts'
import { explorerDataSetUrl } from './pdp-verifier.ts'
import { defaultSubmitDeps, type PresignContext, type SubmitDeps } from './submit-pdp.ts'
import { log } from './util.ts'

/** The minimal permission pair — passed explicitly to every registry call. */
export const SESSION_KEY_PERMISSIONS = [SessionKey.CreateDataSetPermission, SessionKey.AddPiecesPermission]

/**
 * Stop issuing new presign batches when the session has less than this long
 * to live: the provider submits AddPieces on-chain after pulling, and the
 * authorization is checked then, not at presign time. Keep in sync with
 * PRESIGN_SAFETY_MARGIN_SECONDS in app/src/session.ts.
 */
export const PRESIGN_SAFETY_MARGIN_SECONDS = 3_600n

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000))

export type Network = 'calibration' | 'mainnet'

const chainFor = (network: Network) => (network === 'mainnet' ? mainnet : calibration)

export const CHAIN_IDS: Record<Network, number> = {
  mainnet: mainnet.id,
  calibration: calibration.id,
}

/**
 * Read the session's CHAIN-effective expiry: the min of the two permission
 * expiries, 0n when the grant is missing or revoked. Account-less read.
 * Injectable so tests stay off the network.
 */
export type SessionValidator = (
  rpcUrl: string,
  network: Network,
  ids: { root: string; sessionAddress: string }
) => Promise<bigint>

export const validateSessionOnChain: SessionValidator = async (rpcUrl, network, ids) => {
  const readClient = createClient({ chain: chainFor(network), transport: http(rpcUrl) })
  const expirations = await SessionKey.getExpirations(readClient, {
    address: ids.root as Hex,
    sessionKeyAddress: ids.sessionAddress as Hex,
    permissions: SESSION_KEY_PERMISSIONS,
  })
  const expiries = SESSION_KEY_PERMISSIONS.map((p) => expirations[p] ?? 0n)
  return expiries.reduce((a, b) => (a < b ? a : b))
}

/** Derive the session address from the key — never trust a claimed address. */
export function sessionAddressOf(privateKey: string): string {
  return privateKeyToAccount(privateKey as Hex).address
}

/** Thrown by the presign guard when the session is inside the safety margin. */
export class SessionMarginError extends Error {
  constructor(expiresAt: bigint) {
    super(
      `session key expires at ${new Date(Number(expiresAt) * 1000).toISOString()} — inside the ${PRESIGN_SAFETY_MARGIN_SECONDS}s presign margin. Extend the session in the console, then submit again to resume.`
    )
    this.name = 'SessionMarginError'
  }
}

/**
 * Wrap a storage context so every presign honors the safety margin — with the
 * chain as the canonical expiry source: when the cached expiry would block,
 * re-read getExpirations first. An operator who extended the session in the
 * browser mid-run un-blocks the live run with no other action; only a
 * genuinely expiring session throws (leaving the aggregate resumable).
 */
export function guardedPresignContext(
  db: MigrationDB,
  session: SessionKeyRow,
  inner: PresignContext,
  rpcUrl: string,
  network: Network,
  validator: SessionValidator
): PresignContext {
  let cachedExpiry = BigInt(session.expiresAt)
  return {
    presignForCommit: async (pieces) => {
      if (cachedExpiry - nowSeconds() <= PRESIGN_SAFETY_MARGIN_SECONDS) {
        cachedExpiry = await validator(rpcUrl, network, {
          root: session.rootAddress,
          sessionAddress: session.sessionAddress,
        })
        db.updateSessionExpiry(Number(cachedExpiry))
        if (cachedExpiry - nowSeconds() <= PRESIGN_SAFETY_MARGIN_SECONDS) {
          throw new SessionMarginError(cachedExpiry)
        }
        log(
          `session extended on chain; presigning continues (expires ${new Date(Number(cachedExpiry) * 1000).toISOString()})`
        )
      }
      return await inner.presignForCommit(pieces)
    },
  }
}

/**
 * SubmitDeps that sign with the stored session key instead of PRIVATE_KEY.
 * Every presign first honors the safety margin, re-reading the chain when the
 * cached expiry would block (extend-in-place is one wallet tx away).
 */
export function sessionSubmitDeps(
  db: MigrationDB,
  session: SessionKeyRow,
  validator: SessionValidator = validateSessionOnChain
): SubmitDeps {
  return {
    ...defaultSubmitDeps,
    async setup(opts, rpcUrl) {
      const chain = chainFor(opts.network)
      const sessionKey = SessionKey.fromSecp256k1({
        privateKey: session.privateKey as Hex,
        root: session.rootAddress as Hex,
        chain,
        // fromSecp256k1 defaults to the chain's default RPC — honor --rpc-url.
        transport: http(rpcUrl),
      })
      // Address-only payer identity: reads + the createContexts ownership
      // check use client.account.address; nothing here ever signs with it.
      const client = createClient({ account: session.rootAddress as Hex, chain, transport: http(rpcUrl) })
      const synapse = new Synapse({ client, sessionClient: sessionKey.client, source: null })
      const [ctx] = await synapse.storage.createContexts({ dataSetIds: [BigInt(opts.dataSetId)] })
      if (ctx == null) {
        throw new Error(`no storage context for data set ${opts.dataSetId}`)
      }
      const provider = await ctx.getProviderInfo()
      return {
        ctx: guardedPresignContext(db, session, ctx as unknown as PresignContext, rpcUrl, opts.network, validator),
        pdp: new PdpClient(provider.pdp.serviceURL),
        minPieceSize: provider.pdp.minPieceSizeInBytes,
        serviceURL: provider.pdp.serviceURL,
      }
    },
  }
}

/**
 * Session-signed data set creation: same flow as `runCreateDataSet`
 * (create-data-set.ts) but the FWSS CreateDataSet typed-data is signed by the
 * session key with the wallet as explicit payer — no PRIVATE_KEY involved.
 */
export async function createDataSetWithSession(
  session: SessionKeyRow,
  opts: { network: Network; rpcUrl: string; providerId: bigint; cdn?: boolean; timeoutMs?: number }
): Promise<{ dataSetId: number; txHash: string; serviceURL: string; payee: string }> {
  const chain = chainFor(opts.network)
  const sessionKey = SessionKey.fromSecp256k1({
    privateKey: session.privateKey as Hex,
    root: session.rootAddress as Hex,
    chain,
    transport: http(opts.rpcUrl),
  })
  const readClient = createClient({
    account: session.rootAddress as Hex,
    chain,
    transport: http(opts.rpcUrl),
  })

  const registry = new SPRegistryService({ client: readClient })
  const provider = await registry.getProvider({ providerId: opts.providerId })
  if (provider == null) {
    throw new Error(`provider ${opts.providerId} not found in SP registry on ${opts.network}`)
  }
  const serviceURL = provider.pdp.serviceURL
  const payee = provider.payee
  log(`Provider ${opts.providerId} -> ${serviceURL} (payee ${payee})`)

  const { txHash, statusUrl } = await createDataSet(sessionKey.client, {
    serviceURL,
    payee,
    cdn: opts.cdn === true,
    metadata: { withIPFSIndexing: '' },
    payer: session.rootAddress as Hex,
  })
  log(`createDataSet tx ${txHash}; polling ${statusUrl}`)

  const success = await waitForCreateDataSet({ statusUrl, timeout: opts.timeoutMs })
  const dataSetId = Number(success.dataSetId)
  log(`data set ${dataSetId} created -> ${explorerDataSetUrl(opts.network, dataSetId)}`)
  return { dataSetId, txHash, serviceURL, payee }
}

/**
 * The single in-flight chain job: submit runs and data set creations share
 * one slot, serializing session use and answering double-POSTs with one lock.
 */
export interface ChainJob {
  kind: 'submit' | 'create-data-set'
  dataSetId: number | null
  startedAt: string
  finishedAt: string | null
  running: boolean
  lastError: string | null
  lastResult: { dataSetId: number; txHash: string } | null
}
