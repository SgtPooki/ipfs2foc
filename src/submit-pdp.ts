/**
 * PDP submit: drive planned aggregates onto a provider via the pull + aggregate-add
 * path, without relaying payload bytes.
 *
 * Per aggregate:
 *   1. presign AddPieces over the sub-pieces; POST /pdp/piece/pull with each
 *      sourceUrl = <sourceBase>/piece/{pcidv2}. The provider follows the redirect
 *      to the gateway, downloads + verifies each CAR, and parks it.
 *   2. poll the pull (idempotent re-POST of the same body) to complete.
 *   3. presign AddPieces over the aggregate root; POST /pdp/data-sets/{id}/pieces
 *      with the parked sub-pieces. The provider recomputes the aggregate piece commitment,
 *      confirms its root equals ours, and lands one on-chain AddPieces.
 *
 * `extraData` is the FWSS authorization (synapse `presignForCommit`). Submission
 * is bounded by the in-flight cap and the network base fee; pulls honor provider
 * backpressure (HTTP 429 + Retry-After).
 */

import { Synapse, calibration, mainnet } from '@filoz/synapse-sdk'
import { CID } from 'multiformats/cid'
import { type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { MigrationDB } from './db.ts'
import { classifyBaseFee, getBaseFee, resolveRpcUrl } from './gas.ts'
import { formatBytes, formatDuration, formatRate, Timer } from './metrics.ts'
import { PdpClient, PullBackpressure, type PullResponse } from './pdp.ts'
import { activePieceCids, fetchAddPiecesEvent } from './pdp-verifier.ts'
import { pieceAggregateCommP } from './piece-aggregate.ts'
import { log } from './util.ts'

export interface SubmitPdpOptions {
  privateKey: Hex
  network: 'calibration' | 'mainnet'
  rpcUrl?: string
  dataSetId: number
  /** Public base URL of the redirect server, e.g. https://host.ts.net */
  sourceBase: string
  maxInFlight: number
  maxBaseFee: bigint
  pollMs: number
  /** Max sub-pieces per pull request, bounded by the 8192-byte FVM event cap on
   *  the admission eth_call's simulated AddPieces. */
  pullBatch: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runSubmitPdp(db: MigrationDB, opts: SubmitPdpOptions): Promise<void> {
  const rpcUrl = resolveRpcUrl({ rpcUrl: opts.rpcUrl, network: opts.network })
  const chain = opts.network === 'mainnet' ? mainnet : calibration
  const account = privateKeyToAccount(opts.privateKey)

  const synapse = await Synapse.create({ account, transport: http(rpcUrl), chain, source: null })
  const [ctx] = await synapse.storage.createContexts({ dataSetIds: [BigInt(opts.dataSetId)] })
  if (ctx == null) {
    throw new Error(`no storage context for data set ${opts.dataSetId}`)
  }
  const provider = await ctx.getProviderInfo()
  const pdp = new PdpClient(provider.pdp.serviceURL)
  const base = opts.sourceBase.replace(/\/+$/, '')

  log(`PDP submit to ${provider.pdp.serviceURL} (data set ${opts.dataSetId}), pull source ${base}/piece/{pcidv2}`)

  const runTimer = new Timer()
  let committedCount = 0
  let committedBytes = 0
  let totalPullMs = 0
  let totalAddMs = 0

  // Resume any aggregate that has not yet been committed. Pull POSTs are idempotent
  // by (sha256(extraData), dataSetId), so re-issuing on an already-parked aggregate
  // returns complete fast, and the active-pieces guard skips an aggregate whose root
  // is already on chain. A 'failed' aggregate is left for a manual reset.
  const resumable = new Set<string>(['planned', 'submitted', 'parked'])
  for (const agg of db.aggregates().filter((a) => resumable.has(a.status))) {
    if (db.inFlightUncommittedCount() >= opts.maxInFlight) {
      log(`in-flight cap reached (${opts.maxInFlight}); stopping`)
      break
    }
    const reading = classifyBaseFee(await getBaseFee(rpcUrl), opts.maxBaseFee)
    if (reading.pause) {
      log(`base fee ${reading.baseFee} at/above ${opts.maxBaseFee}; pausing`)
      break
    }

    const members = db.aggregateManifest(agg.idx)

    // 1. Pull sub-pieces in batches. The pull admission eth_call-simulates
    // AddPieces over the batch, and PDPVerifier's PiecesAdded event carries one
    // pieceCid per piece; the FVM caps an actor event at 8192 bytes, so a batch
    // of too many sub-pieces reverts the simulation ("total event value lengths
    // exceeded the max size"). Each batch carries its own FWSS extraData
    // (presigned over that batch). The on-chain aggregate-add below stays a
    // single top-level piece regardless, so its event is unaffected.
    const aggBytes = members.reduce((sum, m) => sum + m.rawSize, 0)
    log(
      `aggregate ${agg.idx}: pulling ${members.length} sub-piece(s), ${formatBytes(aggBytes)} ` +
        `in batches of ${opts.pullBatch}`
    )
    db.markSubmitted(agg.idx, `pull-${agg.idx}`)
    const pullTimer = new Timer()
    let failed = 0
    for (let start = 0; start < members.length; start += opts.pullBatch) {
      const batch = members.slice(start, start + opts.pullBatch)
      const batchCids = batch.map((m) => m.pieceCid)
      const attemptId = db.recordPullBatchStart(agg.idx, batchCids)
      const pullExtra = (await ctx.presignForCommit(
        batch.map((m) => ({ pieceCid: CID.parse(m.pieceCid) as never }))
      )) as Hex
      const pullBody = {
        extraData: pullExtra,
        dataSetId: opts.dataSetId,
        pieces: batch.map((m) => ({ pieceCid: m.pieceCid, sourceUrl: `${base}/piece/${m.pieceCid}` })),
      }
      let resp: Awaited<ReturnType<typeof pullWithBackpressure>>
      try {
        resp = await pullWithBackpressure(pdp, pullBody)
        while (!isTerminal(resp)) {
          await sleep(opts.pollMs)
          resp = await pullWithBackpressure(pdp, pullBody)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        db.recordPullBatchResult(attemptId, 0, batch.length, message)
        failed += batch.length
        throw err
      }
      const batchFailed = resp.pieces.filter((p) => p.status === 'failed').length
      db.recordPullBatchResult(attemptId, batch.length - batchFailed, batchFailed)
      failed += batchFailed
    }
    const pullMs = pullTimer.stop()
    if (failed > 0) {
      db.markAggregateFailed(agg.idx, `pull failed for ${failed} piece(s)`)
      log(`aggregate ${agg.idx}: pull failed for ${failed} piece(s)`)
      continue
    }
    db.markParked(agg.idx)
    totalPullMs += pullMs
    log(
      `aggregate ${agg.idx}: parked ${members.length} sub-piece(s) in ${formatDuration(pullMs)} ` +
        `(provider pull ${formatRate(aggBytes, pullMs)})`
    )

    // 2. Add the aggregate over the parked sub-pieces. The provider computes the
    // aggregate piece commitment (commputils.PieceAggregateCommP), so compute it
    // the same way and order sub-pieces largest-padded-first.
    const aggregate = pieceAggregateCommP(members.map((m) => ({ pieceCid: m.pieceCid, rawSize: m.rawSize })))

    // The provider can land the on-chain AddPieces and then fail a later
    // bookkeeping step, returning an error without a tx hash. Reconcile against
    // the data set's active pieces so a re-run skips an aggregate that is already
    // committed rather than adding it a second time.
    if ((await activePieceCids(rpcUrl, opts.network, opts.dataSetId)).has(aggregate.rootPieceCid)) {
      db.markCommitted(agg.idx, { dataSetId: String(opts.dataSetId) })
      committedCount += 1
      committedBytes += aggBytes
      log(`aggregate ${agg.idx}: already on chain (root ${aggregate.rootPieceCid}); marked committed`)
      continue
    }

    const addExtra = (await ctx.presignForCommit([{ pieceCid: CID.parse(aggregate.rootPieceCid) as never }])) as Hex
    const addTimer = new Timer()
    let txHash: string
    try {
      ;({ txHash } = await pdp.addAggregate(
        opts.dataSetId,
        aggregate.rootPieceCid,
        aggregate.orderedSubPieceCids,
        addExtra
      ))
    } catch (err) {
      // The add may have landed on chain before the provider errored. Confirm
      // against active pieces before treating it as a failure.
      if ((await activePieceCids(rpcUrl, opts.network, opts.dataSetId)).has(aggregate.rootPieceCid)) {
        db.markCommitted(agg.idx, { dataSetId: String(opts.dataSetId) })
        committedCount += 1
        committedBytes += aggBytes
        log(`aggregate ${agg.idx}: add errored but landed on chain (root ${aggregate.rootPieceCid}); marked committed`)
        continue
      }
      const addErr = err instanceof Error ? err.message : String(err)
      db.markAggregateFailed(agg.idx, `add failed: ${addErr}`)
      log(`aggregate ${agg.idx}: add failed — ${addErr}`)
      continue
    }
    log(`aggregate ${agg.idx}: AddPieces tx ${txHash} (root ${aggregate.rootPieceCid})`)

    let status: Awaited<ReturnType<typeof pdp.addStatus>> = { done: false, ok: false }
    while (!status.done) {
      await sleep(opts.pollMs)
      status = await pdp.addStatus(opts.dataSetId, txHash)
    }
    const addMs = addTimer.stop()
    if (status.ok) {
      // addStatus's three signals (txStatus + addMessageOk + piecesAdded)
      // confirm Curio's view: the AddPieces tx landed, the inner call
      // succeeded, and Curio finished bookkeeping. The PDPVerifier's
      // PiecesAdded event is the canonical chain witness; verify the
      // aggregate root we presigned matches what the contract emitted
      // before flipping to committed. See `skills/validate-at-each-step.md`
      // and `skills/onchain-canonical-not-side-channel.md`.
      const pieceId = status.confirmedPieceIds?.[0]?.toString()
      let event: Awaited<ReturnType<typeof fetchAddPiecesEvent>> = null
      let eventErr: string | null = null
      try {
        event = await fetchAddPiecesEvent(rpcUrl, opts.network, opts.dataSetId, txHash)
      } catch (err) {
        eventErr = err instanceof Error ? err.message : String(err)
      }
      if (event != null) {
        if (!event.pieceCids.includes(aggregate.rootPieceCid)) {
          const reason =
            `PiecesAdded event root mismatch: expected ${aggregate.rootPieceCid}, ` +
            `saw [${event.pieceCids.join(', ')}]`
          db.markAggregateFailed(agg.idx, `AddPieces tx ${txHash}: ${reason}`)
          log(`aggregate ${agg.idx}: ${reason}`)
          continue
        }
        // PDPVerifier emits one event per AddPieces call with parallel
        // pieceIds/pieceCids arrays; the aggregate root's pieceId is the
        // entry at the matching index.
        const eventPieceId =
          event.pieceIds[event.pieceCids.indexOf(aggregate.rootPieceCid)]?.toString() ?? pieceId
        db.markCommitted(agg.idx, {
          dataSetId: String(opts.dataSetId),
          txHash,
          pieceId: eventPieceId,
          committedBlock: event.blockNumber.toString(),
        })
        log(
          `aggregate ${agg.idx}: committed in ${formatDuration(addMs)} ` +
            `(data set ${opts.dataSetId}, tx ${txHash}, block ${event.blockNumber}, pieceId ${eventPieceId})`
        )
      } else {
        // addStatus said ok but no PiecesAdded event was visible on the
        // receipt the RPC returned. Park the row as committed-unverified
        // so the in-flight cap moves, and let `report`'s on-chain pass
        // reconcile against `activePieceCids`.
        const reason = eventErr ?? 'PiecesAdded event not found on receipt'
        db.markCommittedUnverified(agg.idx, {
          dataSetId: String(opts.dataSetId),
          txHash,
          pieceId,
          reason,
        })
        log(`aggregate ${agg.idx}: committed unverified (tx ${txHash}) — ${reason}`)
      }
      totalAddMs += addMs
      committedCount += 1
      committedBytes += aggBytes
    } else {
      const reason = status.reason ?? 'AddPieces tx did not confirm'
      db.markAggregateFailed(agg.idx, `AddPieces tx ${txHash}: ${reason}`)
      log(`aggregate ${agg.idx}: AddPieces tx ${txHash} — ${reason}`)
    }
  }

  const runMs = runTimer.stop()
  log(
    `PDP run: ${committedCount} aggregate(s), ${formatBytes(committedBytes)} committed in ${formatDuration(runMs)} ` +
      `(pull ${formatDuration(totalPullMs)}, add ${formatDuration(totalAddMs)}; ` +
      `effective ${formatRate(committedBytes, runMs)})`
  )
}

/** A pull batch is terminal when no piece is still pending/in-progress/retrying. */
function isTerminal(resp: PullResponse): boolean {
  return resp.pieces.every((p) => p.status === 'complete' || p.status === 'failed')
}

/** POST the pull, waiting out provider backpressure (429 + Retry-After). */
async function pullWithBackpressure(
  pdp: PdpClient,
  body: { extraData: Hex; dataSetId: number; pieces: Array<{ pieceCid: string; sourceUrl: string }> }
): Promise<PullResponse> {
  for (;;) {
    try {
      return await pdp.pull(body)
    } catch (err) {
      if (err instanceof PullBackpressure) {
        log(`provider backpressure; waiting ${err.retryAfterSeconds}s`)
        await sleep(err.retryAfterSeconds * 1000)
        continue
      }
      throw err
    }
  }
}
