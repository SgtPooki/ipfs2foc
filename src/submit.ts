/**
 * Submit packed aggregates to a storage provider as mk20 AddPiece deals, and
 * advance them to committed.
 *
 * Each deal carries only the manifest: the PODSI aggregate root and its
 * sub-pieces as gateway pull URLs. The provider pulls the sub-piece CARs,
 * assembles the aggregate, and submits the on-chain AddPieces. This stage runs
 * independently of the commP pass, so aggregates submit while later CIDs are
 * still being hashed.
 *
 * Submission is bounded two ways: at most `maxInFlight` aggregates sit
 * uncommitted at once, and submission pauses while the network base fee is at or
 * above `maxBaseFee`.
 *
 * The FWSS AddPieces authorization (`extraData`) and the data set's
 * `clientDataSetId` come from the Synapse SDK; the client address is the
 * Ethereum account's Filecoin f410 form.
 */

import { Synapse, calibration, mainnet } from '@filoz/synapse-sdk'
import { fromEthAddress } from 'iso-filecoin/address'
import { CID } from 'multiformats/cid'
import { type Hex, hexToBytes, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createCurioSigner } from './curio-auth.ts'
import type { MigrationDB } from './db.ts'
import { classifyBaseFee, getBaseFee, resolveRpcUrl } from './gas.ts'
import { buildAddPieceDeal, Mk20Client } from './mk20.ts'
import { log } from './util.ts'

export interface SubmitOptions {
  privateKey: Hex
  network: 'calibration' | 'mainnet'
  rpcUrl?: string
  dataSetId: number
  maxInFlight: number
  maxBaseFee: bigint
  indexing: boolean
  announce: boolean
}

export interface SubmitContext {
  db: MigrationDB
  mk20: Mk20Client
  dataSetId: number
  network: 'calibration' | 'mainnet'
}

/**
 * Submit `planned` aggregates as AddPiece deals, up to the in-flight cap and
 * while the base fee allows. Returns a reusable context for status polling.
 */
export async function runSubmit(db: MigrationDB, opts: SubmitOptions): Promise<SubmitContext> {
  const rpcUrl = resolveRpcUrl({ rpcUrl: opts.rpcUrl, network: opts.network })
  const chain = opts.network === 'mainnet' ? mainnet : calibration
  const account = privateKeyToAccount(opts.privateKey)

  const synapse = await Synapse.create({ account, transport: http(rpcUrl), chain, source: null })
  const [context] = await synapse.storage.createContexts({ dataSetIds: [BigInt(opts.dataSetId)] })
  if (context == null) {
    throw new Error(`no storage context for data set ${opts.dataSetId}`)
  }

  const recordKeeper = synapse.chain.contracts.fwss.address
  const clientAddress = fromEthAddress(account.address, opts.network === 'mainnet' ? 'mainnet' : 'testnet').toString()
  const provider = await context.getProviderInfo()
  const mk20 = new Mk20Client(provider.pdp.serviceURL, createCurioSigner(opts.privateKey))

  log(`submitting to ${provider.pdp.serviceURL} as ${clientAddress} (data set ${opts.dataSetId})`)

  for (const agg of db.aggregates().filter((a) => a.status === 'planned')) {
    if (db.inFlightUncommittedCount() >= opts.maxInFlight) {
      log(`in-flight cap reached (${opts.maxInFlight}); leaving remaining aggregates planned`)
      break
    }
    const reading = classifyBaseFee(await getBaseFee(rpcUrl), opts.maxBaseFee)
    if (reading.pause) {
      log(`base fee ${reading.baseFee} attoFIL/gas at/above ${opts.maxBaseFee}; pausing submission`)
      break
    }

    const members = db.aggregateManifest(agg.idx)
    const extraData = await context.presignForCommit([{ pieceCid: CID.parse(agg.rootPieceCid) as never }])

    const deal = buildAddPieceDeal({
      clientAddress,
      dataSetId: opts.dataSetId,
      recordKeeper,
      extraData: hexToBytes(extraData),
      aggregateRootPieceCid: agg.rootPieceCid,
      subPieces: members.map((m) => ({ pieceCid: m.pieceCid, urls: [m.url] })),
      indexing: opts.indexing,
      announcePayload: opts.announce,
    })

    const res = await mk20.submitDeal(deal)
    db.markSubmitted(agg.idx, res.identifier)
    log(`aggregate ${agg.idx} submitted as deal ${res.identifier} (${members.length} sub-pieces)`)
  }

  return { db, mk20, dataSetId: opts.dataSetId, network: opts.network }
}

/**
 * Poll every `submitted` aggregate once and advance its lifecycle. Returns the
 * count still in flight, so a caller can loop until it reaches zero.
 */
export async function pollSubmitted(ctx: SubmitContext): Promise<number> {
  for (const agg of ctx.db.aggregates().filter((a) => a.status === 'submitted')) {
    if (agg.dealId == null) {
      continue
    }
    try {
      const status = await ctx.mk20.status(agg.dealId)
      if (status.lifecycle === 'committed') {
        ctx.db.markCommitted(agg.idx, { dataSetId: String(ctx.dataSetId) })
        log(`aggregate ${agg.idx} committed (data set ${ctx.dataSetId}, root ${agg.rootPieceCid})`)
      } else if (status.lifecycle === 'failed') {
        ctx.db.markAggregateFailed(agg.idx)
        log(`aggregate ${agg.idx} failed: ${status.errorMsg || status.state}`)
      }
    } catch (err) {
      log(`status poll for aggregate ${agg.idx} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return ctx.db.inFlightUncommittedCount()
}

/** PDP explorer base for a network, for confirmation links. */
export function explorerBase(network: 'calibration' | 'mainnet'): string {
  return `https://pdp.vxb.ai/${network}`
}
