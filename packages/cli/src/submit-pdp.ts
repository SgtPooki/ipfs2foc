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

import { unlink } from 'node:fs/promises'
import { calibration, mainnet, Synapse } from '@filoz/synapse-sdk'
import { canonicalCid, relayPullUrl } from 'ipfs2foc-core'
import { checkMinPieceSize } from 'ipfs2foc-core/min-piece-guard'
import { pieceAggregateCommP } from 'ipfs2foc-core/piece-aggregate'
import { CID } from 'multiformats/cid'
import { type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { MigrationDB } from './db.ts'
import { classifyBaseFee, getBaseFee, resolveRpcUrl } from './gas.ts'
import { formatBytes, formatDuration, formatRate, Timer } from './metrics.ts'
import { type AddStatusResult, PdpClient, PullBackpressure, type PullResponse } from './pdp.ts'
import { type AddPiecesEvent, activePieceCids, fetchAddPiecesEvent } from './pdp-verifier.ts'
import { log } from './util.ts'

/**
 * Evict cached multi-asset CAR files for an aggregate once it has been
 * committed on-chain. The provider has parked and verified every byte; the
 * gateways are no longer needed; disk can come back. Errors are logged but
 * never thrown — eviction is best-effort and never blocks the run.
 */
async function evictCachedCars(db: MigrationDB, aggregateIdx: number): Promise<void> {
  const paths = db.carPathsForAggregateOnCommit(aggregateIdx)
  for (const path of paths) {
    try {
      await unlink(path)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`  evict ${path}: ${message}`)
    }
  }
}

export interface SubmitPdpOptions {
  privateKey: Hex
  network: 'calibration' | 'mainnet'
  rpcUrl?: string
  dataSetId: number
  /**
   * Public base URL of an operator-run redirect server, e.g. https://host.ts.net.
   * The provider is pointed at `{sourceBase}/piece/{pcidv2}`. Mutually exclusive
   * with {@link sourceRelay}.
   */
  sourceBase?: string
  /**
   * Public base URL of a shared, stateless redirect relay (e.g. the hosted
   * Cloudflare Worker). When set, the per-piece pull URL is the path-encoded
   * `{sourceRelay}/r/{gatewayHost}/{cid}/piece/{pcidv2}` so no per-operator
   * server is needed. Passthrough sub-pieces only — assembled CARs have no
   * gateway URL to relay to.
   */
  sourceRelay?: string
  maxInFlight: number
  maxBaseFee: bigint
  pollMs: number
  /** Max sub-pieces per pull request, bounded by the 8192-byte FVM event cap on
   *  the admission eth_call's simulated AddPieces. */
  pullBatch: number
  /** Override the AddPieces-confirm deadline (default `ADD_CONFIRM_TIMEOUT_MS`). */
  addConfirmTimeoutMs?: number
  /** Override the pull no-progress stall window (default `PULL_STALL_TIMEOUT_MS`). */
  pullStallTimeoutMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The pull `sourceUrl` the provider is handed for one sub-piece. Either the
 * operator's redirect server (`{sourceBase}/piece/{pcid}`) or the shared
 * stateless relay (`{sourceRelay}/r/{gatewayHost}/{cid}/piece/{pcid}`, derived
 * from the sub-piece's gateway CAR URL so the relay can rebuild the exact bytes
 * the piece was committed over).
 */
function pullSourceUrl(opts: SubmitPdpOptions, member: { pieceCid: string; url: string }): string {
  if (opts.sourceRelay != null && opts.sourceRelay !== '') {
    if (member.url === '') {
      throw new Error(
        `sub-piece ${member.pieceCid} has no gateway URL; assembled CARs cannot be served via --source-relay (use --source-base with redirect-serve)`
      )
    }
    const carUrl = new URL(member.url)
    const cid = carUrl.pathname.replace(/^\/ipfs\//, '')
    const canonical = canonicalCid(cid)
    if (canonical == null) {
      throw new Error(`source CID ${cid} is not a canonical CIDv1; the relay requires it (re-encode before plan)`)
    }
    return relayPullUrl(opts.sourceRelay, carUrl.hostname, canonical, member.pieceCid)
  }
  return `${(opts.sourceBase ?? '').replace(/\/+$/, '')}/piece/${member.pieceCid}`
}

/**
 * Give up waiting for an AddPieces tx to confirm after this long. The tx hash is
 * already persisted, so the next run resumes from the receipt poll rather than
 * re-adding — a stuck provider or RPC blackhole no longer hangs the whole run.
 */
const ADD_CONFIRM_TIMEOUT_MS = 15 * 60_000
/**
 * Treat a pull as stalled if no additional sub-piece reaches a terminal state
 * (complete/failed) within this window. A genuinely slow-but-progressing pull
 * keeps advancing and resets the timer; a hung provider trips it. Pulls have no
 * on-chain effect, so a stalled pull fails the aggregate and the run moves on.
 */
const PULL_STALL_TIMEOUT_MS = 15 * 60_000

/** Sub-pieces that have reached a terminal pull state (complete or failed). */
function terminalPieceCount(resp: PullResponse): number {
  return resp.pieces.filter((p) => p.status === 'complete' || p.status === 'failed').length
}

/** Presigning surface the submit loop needs from a storage context. */
export interface PresignContext {
  presignForCommit(pieces: Array<{ pieceCid: unknown }>): Promise<unknown>
}

/** The PdpClient surface the submit loop drives. */
export interface PdpLike {
  pull(body: {
    extraData: Hex
    dataSetId: number
    pieces: Array<{ pieceCid: string; sourceUrl: string }>
  }): Promise<PullResponse>
  addAggregate(
    dataSetId: number,
    root: string,
    subPieceCids: string[],
    extraData: Hex
  ): Promise<{ txHash: string; statusUrl: string }>
  addStatus(dataSetId: number, txHash: string): Promise<AddStatusResult>
}

/**
 * External dependencies of the submit loop, injected so the control flow (pull,
 * add, confirm, resume, reconcile) can be driven in tests with a fake provider
 * and chain. Production uses `defaultSubmitDeps`, which wires the real Synapse
 * context, PdpClient, and on-chain reads.
 */
export interface SubmitDeps {
  setup(
    opts: SubmitPdpOptions,
    rpcUrl: string
  ): Promise<{
    ctx: PresignContext
    pdp: PdpLike
    minPieceSize: bigint
    serviceURL: string
  }>
  activePieceCids(rpcUrl: string, network: 'calibration' | 'mainnet', dataSetId: number): Promise<Set<string>>
  fetchAddPiecesEvent(
    rpcUrl: string,
    network: 'calibration' | 'mainnet',
    dataSetId: number,
    txHash: string
  ): Promise<AddPiecesEvent | null>
  getBaseFee(rpcUrl: string): Promise<bigint>
}

export const defaultSubmitDeps: SubmitDeps = {
  async setup(opts, rpcUrl) {
    const chain = opts.network === 'mainnet' ? mainnet : calibration
    const account = privateKeyToAccount(opts.privateKey)
    const synapse = await Synapse.create({ account, transport: http(rpcUrl), chain, source: null })
    const [ctx] = await synapse.storage.createContexts({ dataSetIds: [BigInt(opts.dataSetId)] })
    if (ctx == null) {
      throw new Error(`no storage context for data set ${opts.dataSetId}`)
    }
    const provider = await ctx.getProviderInfo()
    return {
      ctx: ctx as unknown as PresignContext,
      pdp: new PdpClient(provider.pdp.serviceURL),
      minPieceSize: provider.pdp.minPieceSizeInBytes,
      serviceURL: provider.pdp.serviceURL,
    }
  },
  activePieceCids,
  fetchAddPiecesEvent,
  getBaseFee,
}

export async function runSubmitPdp(
  db: MigrationDB,
  opts: SubmitPdpOptions,
  deps: SubmitDeps = defaultSubmitDeps
): Promise<void> {
  const rpcUrl = resolveRpcUrl({ rpcUrl: opts.rpcUrl, network: opts.network })
  const addConfirmTimeoutMs = opts.addConfirmTimeoutMs ?? ADD_CONFIRM_TIMEOUT_MS
  const pullStallTimeoutMs = opts.pullStallTimeoutMs ?? PULL_STALL_TIMEOUT_MS

  const { ctx, pdp, minPieceSize, serviceURL } = await deps.setup(opts, rpcUrl)

  const pullSourceDesc =
    opts.sourceRelay != null && opts.sourceRelay !== ''
      ? `${opts.sourceRelay.replace(/\/+$/, '')}/r/{gateway}/{cid}/piece/{pcidv2}`
      : `${(opts.sourceBase ?? '').replace(/\/+$/, '')}/piece/{pcidv2}`

  log(
    `PDP submit to ${serviceURL} (data set ${opts.dataSetId}), pull source ${pullSourceDesc}, ` +
      `provider min piece size ${minPieceSize} bytes`
  )

  const runTimer = new Timer()
  let committedCount = 0
  let committedBytes = 0
  let totalPullMs = 0
  let totalAddMs = 0

  // Resume any aggregate that has not yet been committed. Pull POSTs are idempotent
  // by (sha256(extraData), dataSetId), so re-issuing on an already-parked aggregate
  // returns complete fast, and the active-pieces guard skips an aggregate whose root
  // is already on chain. A 'failed' aggregate is left for a manual reset.
  const resumable = new Set<string>(['planned', 'submitted', 'parked', 'add_unconfirmed'])
  for (const agg of db.aggregates().filter((a) => resumable.has(a.status))) {
    if (db.inFlightUncommittedCount() >= opts.maxInFlight) {
      log(`in-flight cap reached (${opts.maxInFlight}); stopping`)
      break
    }
    const reading = classifyBaseFee(await deps.getBaseFee(rpcUrl), opts.maxBaseFee)
    if (reading.pause) {
      log(`base fee ${reading.baseFee} at/above ${opts.maxBaseFee}; pausing`)
      break
    }

    const members = db.aggregateManifest(agg.idx)
    const aggBytesPlanned = members.reduce((sum, m) => sum + m.rawSize, 0)

    // Refuse to pull an aggregate whose sub-pieces fall below the provider's
    // padded min piece size. Without the guard the provider rejects mid-pull
    // and the operator burns a tunnel cycle (issue #17). Skip only aggregates
    // that have not yet been submitted; a resume row (txHash set, status
    // submitted/parked) has already cleared this check on a prior run.
    if (agg.txHash == null && agg.status === 'planned') {
      const check = checkMinPieceSize(members, minPieceSize)
      if (!check.ok) {
        const names = check.tooSmall.map((s) => `${s.pieceCid} (padded ${s.paddedSize})`).join(', ')
        const reason =
          `sub-piece(s) below provider min piece size ${minPieceSize}: ${names}. ` +
          `Re-pack with \`pack-cars --pack-target-size\` at or above the provider minimum.`
        db.markAggregateFailed(agg.idx, reason)
        log(`aggregate ${agg.idx}: ${reason}`)
        continue
      }
    }

    // Resume path: a prior run sent the AddPieces tx but was killed before the
    // receipt parse landed. Skip pull + add and jump straight to receipt
    // validation using the persisted tx_hash.
    if (agg.txHash != null) {
      const aggregate = pieceAggregateCommP(members.map((m) => ({ pieceCid: m.pieceCid, rawSize: m.rawSize })))
      log(`aggregate ${agg.idx}: resuming receipt validation for tx ${agg.txHash} (root ${aggregate.rootPieceCid})`)
      const onChain = await deps.activePieceCids(rpcUrl, opts.network, opts.dataSetId)
      if (onChain.has(aggregate.rootPieceCid)) {
        let event: Awaited<ReturnType<typeof fetchAddPiecesEvent>> = null
        try {
          event = await deps.fetchAddPiecesEvent(rpcUrl, opts.network, opts.dataSetId, agg.txHash)
        } catch {
          /* fall through */
        }
        if (event?.pieceCids.includes(aggregate.rootPieceCid)) {
          const eventPieceId = event.pieceIds[event.pieceCids.indexOf(aggregate.rootPieceCid)]?.toString()
          db.markCommitted(agg.idx, {
            dataSetId: String(opts.dataSetId),
            txHash: agg.txHash,
            pieceId: eventPieceId,
            committedBlock: event.blockNumber.toString(),
          })
        } else {
          db.markCommittedUnverified(agg.idx, {
            dataSetId: String(opts.dataSetId),
            txHash: agg.txHash,
            reason: 'resumed without receipt event match',
          })
        }
        await evictCachedCars(db, agg.idx)
        committedCount += 1
        committedBytes += aggBytesPlanned
        log(`aggregate ${agg.idx}: committed via resume (data set ${opts.dataSetId}, tx ${agg.txHash})`)
      } else {
        log(`aggregate ${agg.idx}: tx ${agg.txHash} not yet visible on chain; will retry on next run`)
      }
      continue
    }

    // Resume path: an add was attempted but no tx hash was ever persisted — the
    // process was killed mid-add, or the provider errored without returning a
    // hash. Re-pulling and re-adding here would risk a second AddPieces for the
    // same root, so reconcile against the chain instead: commit if the root
    // landed, otherwise leave the row for the operator to verify and reset
    // (`--retry-unconfirmed`). Never blindly re-add.
    if (agg.status === 'add_unconfirmed') {
      const aggregate = pieceAggregateCommP(members.map((m) => ({ pieceCid: m.pieceCid, rawSize: m.rawSize })))
      const onChain = await deps.activePieceCids(rpcUrl, opts.network, opts.dataSetId)
      if (onChain.has(aggregate.rootPieceCid)) {
        db.markCommitted(agg.idx, { dataSetId: String(opts.dataSetId) })
        await evictCachedCars(db, agg.idx)
        committedCount += 1
        committedBytes += aggBytesPlanned
        log(
          `aggregate ${agg.idx}: unconfirmed add reconciled — root ${aggregate.rootPieceCid} on chain; marked committed`
        )
      } else {
        log(
          `aggregate ${agg.idx}: AddPieces was attempted but root ${aggregate.rootPieceCid} is not on chain ` +
            `and no tx hash was recorded. Not re-adding (would risk a duplicate). Verify on chain; ` +
            `if absent, re-run with --retry-unconfirmed.`
        )
      }
      continue
    }

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
    // A pull error/stall fails this aggregate and moves on to the next, rather
    // than throwing out of the loop and aborting every later aggregate. Pulls
    // have no on-chain effect and are idempotent, so a failed aggregate is safe
    // to reset and re-pull.
    let pullErrored: string | null = null
    for (let start = 0; start < members.length && pullErrored == null; start += opts.pullBatch) {
      const batch = members.slice(start, start + opts.pullBatch)
      const batchCids = batch.map((m) => m.pieceCid)
      const attemptId = db.recordPullBatchStart(agg.idx, batchCids)
      const pullExtra = (await ctx.presignForCommit(
        batch.map((m) => ({ pieceCid: CID.parse(m.pieceCid) as never }))
      )) as Hex
      const pullBody = {
        extraData: pullExtra,
        dataSetId: opts.dataSetId,
        pieces: batch.map((m) => ({ pieceCid: m.pieceCid, sourceUrl: pullSourceUrl(opts, m) })),
      }
      try {
        let resp = await pullWithBackpressure(pdp, pullBody)
        // Stall watchdog: reset the deadline whenever another sub-piece reaches a
        // terminal state. Only a pull that makes no progress at all trips it.
        let progress = terminalPieceCount(resp)
        let stallDeadline = Date.now() + pullStallTimeoutMs
        while (!isTerminal(resp)) {
          await sleep(opts.pollMs)
          resp = await pullWithBackpressure(pdp, pullBody)
          const now = terminalPieceCount(resp)
          if (now > progress) {
            progress = now
            stallDeadline = Date.now() + pullStallTimeoutMs
          } else if (Date.now() > stallDeadline) {
            throw new Error(
              `pull stalled: no sub-piece reached a terminal state for ${formatDuration(pullStallTimeoutMs)}`
            )
          }
        }
        const batchFailed = resp.pieces.filter((p) => p.status === 'failed').length
        db.recordPullBatchResult(attemptId, batch.length - batchFailed, batchFailed)
        failed += batchFailed
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        db.recordPullBatchResult(attemptId, 0, batch.length, message)
        failed += batch.length
        pullErrored = message
      }
    }
    const pullMs = pullTimer.stop()
    if (pullErrored != null) {
      db.markAggregateFailed(agg.idx, `pull error: ${pullErrored}`)
      log(`aggregate ${agg.idx}: pull error — ${pullErrored}`)
      continue
    }
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
    if ((await deps.activePieceCids(rpcUrl, opts.network, opts.dataSetId)).has(aggregate.rootPieceCid)) {
      db.markCommitted(agg.idx, { dataSetId: String(opts.dataSetId) })
      committedCount += 1
      committedBytes += aggBytes
      log(`aggregate ${agg.idx}: already on chain (root ${aggregate.rootPieceCid}); marked committed`)
      continue
    }

    const addExtra = (await ctx.presignForCommit([{ pieceCid: CID.parse(aggregate.rootPieceCid) as never }])) as Hex
    const addTimer = new Timer()
    // Durable breadcrumb BEFORE the add. If the process is killed mid-add (tx
    // broadcast, no response persisted) or the provider errors without returning
    // a tx hash, the row is left `add_unconfirmed` — the resume path reconciles
    // it against the chain instead of re-pulling and re-adding, which would land
    // a duplicate AddPieces tx for the same root.
    db.markAggregateAddUnconfirmed(agg.idx, 'AddPieces submitted; awaiting on-chain confirmation')
    let txHash: string
    try {
      ;({ txHash } = await pdp.addAggregate(
        opts.dataSetId,
        aggregate.rootPieceCid,
        aggregate.orderedSubPieceCids,
        addExtra
      ))
      // Persist the tx hash as soon as we have it so resume can poll the receipt
      // (`aggregatesAwaitingReceipt`) rather than re-adding.
      db.markAggregateTxSubmitted(agg.idx, txHash)
    } catch (err) {
      // The add may have landed on chain before the provider errored. Confirm
      // against active pieces first; otherwise leave it `add_unconfirmed` (NOT
      // `failed`) so a bulk failed-reset can't blindly re-add a root that may
      // already be on chain.
      if ((await deps.activePieceCids(rpcUrl, opts.network, opts.dataSetId)).has(aggregate.rootPieceCid)) {
        db.markCommitted(agg.idx, { dataSetId: String(opts.dataSetId) })
        committedCount += 1
        committedBytes += aggBytes
        log(`aggregate ${agg.idx}: add errored but landed on chain (root ${aggregate.rootPieceCid}); marked committed`)
        continue
      }
      const addErr = err instanceof Error ? err.message : String(err)
      db.markAggregateAddUnconfirmed(
        agg.idx,
        `add errored: ${addErr}; outcome unknown — verify root on chain before retrying (--retry-unconfirmed)`
      )
      log(`aggregate ${agg.idx}: add errored, outcome unconfirmed — ${addErr}`)
      continue
    }
    log(`aggregate ${agg.idx}: AddPieces tx ${txHash} (root ${aggregate.rootPieceCid})`)

    let status: Awaited<ReturnType<typeof pdp.addStatus>> = { done: false, ok: false }
    const addDeadline = Date.now() + addConfirmTimeoutMs
    while (!status.done) {
      if (Date.now() > addDeadline) {
        log(
          `aggregate ${agg.idx}: AddPieces tx ${txHash} not confirmed within ` +
            `${formatDuration(addConfirmTimeoutMs)}; tx hash persisted, will resume on next run`
        )
        break
      }
      await sleep(opts.pollMs)
      status = await pdp.addStatus(opts.dataSetId, txHash)
    }
    // Timed out waiting for confirmation: the row is `add_unconfirmed` with a tx
    // hash set, so the next run resumes via the receipt branch. Do not fall
    // through to the failure branch.
    if (!status.done) continue
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
        event = await deps.fetchAddPiecesEvent(rpcUrl, opts.network, opts.dataSetId, txHash)
      } catch (err) {
        eventErr = err instanceof Error ? err.message : String(err)
      }
      if (event == null) {
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
        await evictCachedCars(db, agg.idx)
        log(`aggregate ${agg.idx}: committed unverified (tx ${txHash}) — ${reason}`)
      } else {
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
        const eventPieceId = event.pieceIds[event.pieceCids.indexOf(aggregate.rootPieceCid)]?.toString() ?? pieceId
        db.markCommitted(agg.idx, {
          dataSetId: String(opts.dataSetId),
          txHash,
          pieceId: eventPieceId,
          committedBlock: event.blockNumber.toString(),
        })
        await evictCachedCars(db, agg.idx)
        log(
          `aggregate ${agg.idx}: committed in ${formatDuration(addMs)} ` +
            `(data set ${opts.dataSetId}, tx ${txHash}, block ${event.blockNumber}, pieceId ${eventPieceId})`
        )
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
  pdp: PdpLike,
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
