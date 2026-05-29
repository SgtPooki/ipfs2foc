/**
 * Verification report: layered evidence that every committed CID is held by
 * the storage provider.
 *
 * Layer 1 (always): local DB accounting. Every input CID lands in one of
 *   `{committed, pending, failed, oversized, unaccounted}`. `unaccounted > 0`
 *   means the DB has a status the report does not understand and exits
 *   non-zero.
 *
 * Layer 2 (always): on-chain reconciliation against the PDPVerifier contract.
 *   For each local aggregate, the root is recomputed from members (the
 *   authoritative value the SP re-derives on add) and matched against the
 *   data set's `getActivePieces`. Plus a single read of
 *   `getDataSetLastProvenEpoch` shows whether the SP has produced a valid
 *   proof-of-possession after the run's final AddPieces. PoP samples
 *   pseudo-random chunks of the data set, so a valid proof requires holding
 *   the bytes — this is the strongest "data is at the SP" evidence short of
 *   downloading it back out.
 *
 * Layer 3 (opt-in `--check-ipni`): query the delegated-routing endpoint for
 *   a sample of committed CIDs. A provider record from the SP confirms it
 *   advertised the CID into IPNI, which is what makes the CID discoverable
 *   on the IPFS network through any gateway. This is announcement signal,
 *   not possession signal — Layer 2 is what proves possession.
 */

import type { MigrationDB } from './db.ts'
import { resolveRpcUrl } from './gas.ts'
import {
  activePieceCids,
  dataSetProofHealth,
  explorerDataSetUrl,
  explorerPieceUrl,
  maxBlockOfTxHashes,
  type ProofHealth,
} from './pdp-verifier.ts'
import { pieceAggregateCommP } from './piece-aggregate.ts'
import { log } from './util.ts'

export interface ReportOptions {
  network: 'calibration' | 'mainnet'
  rpcUrl?: string
  dataSetId: number
  /** When set, query this delegated-routing endpoint for an IPNI announcement check on a sample of committed CIDs. */
  ipniEndpoint?: string
  /** Cap on CIDs probed under `--check-ipni`. Defaults to 100. Pass `Infinity` for an exhaustive sweep. */
  ipniSample?: number
  /** Bound on concurrent IPNI probes. Default 8. */
  ipniConcurrency?: number
}

export interface AggregateReport {
  idx: number
  status: string
  members: number
  root: string
  txHash: string | null
  onChain: boolean
  dataSetUrl: string
  pieceUrl: string
}

export interface IpniCheck {
  endpoint: string
  /** How many CIDs were probed (less than `population` if sampled). */
  probed: number
  /** Total committed CIDs the sample was drawn from. */
  population: number
  /** Announced: the endpoint returned at least one provider record for the CID. */
  announced: number
  /** Not announced: empty provider list or 404. */
  notAnnounced: number
  /** First few not-announced CIDs with the response that came back. */
  examples: Array<{ cid: string; reason: string }>
}

export interface Report {
  dataSetId: number
  network: 'calibration' | 'mainnet'
  cids: {
    total: number
    committed: number
    pending: number
    failed: number
    oversized: number
    unaccounted: number
  }
  failuresByCategory: Record<string, number>
  aggregates: AggregateReport[]
  discrepancies: string[]
  /** Piece CIDs present on chain for this data set that no local aggregate root matches. Populated when the local DB has been lost or never ran a plan for these pieces. */
  unaccountedOnChain: string[]
  /** On-chain proof-of-possession health for the data set. */
  proof: ProofHealth
  /** Optional IPNI announcement sample, set only when `--check-ipni` is passed. */
  ipni?: IpniCheck
  /** True when every input CID is accounted for AND on-chain proof shows the SP has proven possession since the latest AddPieces. */
  complete: boolean
}

/**
 * JSON.stringify replacer that turns bigint values into decimal strings.
 * `Report` contains epoch counters and other chain-side values as bigints; the
 * default `JSON.stringify` throws on them.
 */
export function bigintJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

/**
 * Chain-side roots that no local aggregate accounted for. The operator may have
 * lost the DB, or a prior run committed pieces under a different DB file. The
 * `report` CLI treats a non-empty result as a hard error unless
 * `--allow-unaccounted` is set.
 */
export function findUnaccountedOnChain(onChain: Set<string>, localRoots: string[]): string[] {
  const local = new Set(localRoots)
  return [...onChain].filter((r) => !local.has(r))
}

export async function runReport(db: MigrationDB, opts: ReportOptions): Promise<Report> {
  const rpcUrl = resolveRpcUrl({ rpcUrl: opts.rpcUrl, network: opts.network })
  const onChainRoots = await activePieceCids(rpcUrl, opts.network, opts.dataSetId)
  const counts = db.counts()

  const aggregates: AggregateReport[] = []
  const discrepancies: string[] = []
  const committedAggs: Array<{ idx: number; memberCount: number }> = []
  const committedTxHashes: string[] = []
  let committed = 0

  for (const agg of db.aggregates()) {
    const members = db.aggregateManifest(agg.idx)
    const root = pieceAggregateCommP(members.map((m) => ({ pieceCid: m.pieceCid, rawSize: m.rawSize }))).rootPieceCid
    const onChain = onChainRoots.has(root)
    if (onChain) {
      committed += agg.memberCount
      committedAggs.push({ idx: agg.idx, memberCount: agg.memberCount })
      if (agg.txHash != null) committedTxHashes.push(agg.txHash)
    }
    if (onChain && agg.status !== 'committed') {
      discrepancies.push(`aggregate ${agg.idx} is on chain but local status is '${agg.status}'`)
    }
    if (!onChain && agg.status === 'committed') {
      discrepancies.push(`aggregate ${agg.idx} is marked committed locally but is not on chain`)
    }
    aggregates.push({
      idx: agg.idx,
      status: agg.status,
      members: agg.memberCount,
      root,
      txHash: agg.txHash,
      onChain,
      dataSetUrl: explorerDataSetUrl(opts.network, opts.dataSetId),
      pieceUrl: explorerPieceUrl(opts.network, root),
    })
  }

  const pending = counts.pending + counts.processing + counts.done
  // `done` CIDs not yet in a committed aggregate count as pending from the
  // operator's perspective. Subtract committed to avoid double counting.
  const pendingNotCommitted = Math.max(0, pending - committed)
  const unaccounted = Math.max(
    0,
    counts.total - committed - pendingNotCommitted - counts.failed - counts.oversized
  )

  // Pull the latest AddPieces block across all committed aggregates so the
  // proof check can ask "has the SP proven possession after the run's final
  // add?". Aggregates committed without a stored txHash (e.g. detected as
  // already on-chain by an earlier run) contribute nothing to the max; if
  // every committed aggregate is in that state, `maxAddEpoch` is null and
  // `provenSinceAdd` then means "any proof for this set after any add".
  const maxAddEpoch = await maxBlockOfTxHashes(rpcUrl, opts.network, committedTxHashes)
  const proof = await dataSetProofHealth(rpcUrl, opts.network, opts.dataSetId, maxAddEpoch)

  const unaccountedOnChain = findUnaccountedOnChain(
    onChainRoots,
    aggregates.map((a) => a.root)
  )

  const report: Report = {
    dataSetId: opts.dataSetId,
    network: opts.network,
    cids: {
      total: counts.total,
      committed,
      pending: pendingNotCommitted,
      failed: counts.failed,
      oversized: counts.oversized,
      unaccounted,
    },
    failuresByCategory: db.failuresByCategory(),
    aggregates,
    discrepancies,
    unaccountedOnChain,
    proof,
    complete:
      unaccounted === 0 &&
      pendingNotCommitted === 0 &&
      counts.failed === 0 &&
      unaccountedOnChain.length === 0 &&
      proof.provenSinceAdd &&
      proof.inGoodStanding,
  }

  if (opts.ipniEndpoint != null && committed > 0) {
    const sampleSize = opts.ipniSample ?? 100
    const sample = collectSample(db, committedAggs, committed, sampleSize)
    report.ipni = await checkIpni(sample, committed, opts.ipniEndpoint, opts.ipniConcurrency ?? 8)
  }

  log(`Data set ${opts.dataSetId} (${opts.network}) — ${explorerDataSetUrl(opts.network, opts.dataSetId)}`)
  log(
    `CIDs: ${report.cids.committed}/${report.cids.total} committed on chain, ` +
      `${report.cids.pending} pending, ${report.cids.failed} failed, ` +
      `${report.cids.oversized} oversized` +
      (unaccounted > 0 ? `, ${unaccounted} unaccounted` : '')
  )
  log(
    `PoP: data-set ${proof.live ? 'live' : 'NOT live'}, ` +
      `last proven epoch ${proof.lastProvenEpoch ?? 'never'}, ` +
      `current ${proof.currentEpoch}, next challenge ${proof.nextChallengeEpoch}, ` +
      `${proof.activePieceCount} active piece(s)` +
      (proof.provenSinceAdd ? ' — proven since latest AddPieces' : ' — NOT yet proven since latest AddPieces') +
      (proof.inGoodStanding ? '' : ' — past next challenge deadline')
  )
  if (Object.keys(report.failuresByCategory).length > 0) {
    const summary = Object.entries(report.failuresByCategory)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    log(`Failures by category: ${summary}`)
  }
  for (const a of aggregates) {
    log(
      `  aggregate ${a.idx} [${a.onChain ? 'on-chain' : a.status}] ${a.members} CID(s) ${a.root}` +
        `\n    piece:   ${a.pieceUrl}` +
        (a.txHash != null ? `\n    tx:      ${a.txHash}` : '')
    )
  }
  if (discrepancies.length > 0) {
    log('Discrepancies:')
    for (const d of discrepancies) {
      log(`  ${d}`)
    }
  }
  if (report.ipni != null) {
    const i = report.ipni
    const scope = i.probed === i.population ? `all ${i.population}` : `sample ${i.probed}/${i.population}`
    log(`IPNI check (${i.endpoint}, ${scope}): ${i.announced} announced, ${i.notAnnounced} not announced`)
    for (const ex of i.examples) {
      log(`  ! ${ex.cid}: ${ex.reason}`)
    }
  }

  return report
}

/**
 * Query a delegated-routing V1 endpoint for each CID and count how many have
 * at least one provider record. The endpoint is the IPFS public utility
 * (`https://delegated-ipfs.dev`) or any equivalent — the routing V1 spec is
 * the canonical surface: `GET /routing/v1/providers/{cid}` returns a JSON
 * array of provider records when announced, 404 / empty when not.
 *
 * This is "did the SP tell IPNI about this CID" evidence, distinct from
 * "does the SP currently hold the bytes" (Layer 2 / proof-of-possession).
 */
async function checkIpni(
  cids: string[],
  population: number,
  endpoint: string,
  concurrency: number
): Promise<IpniCheck> {
  let announced = 0
  let notAnnounced = 0
  const examples: Array<{ cid: string; reason: string }> = []
  const base = endpoint.replace(/\/+$/, '')
  let cursor = 0

  const probeOne = async (cid: string): Promise<void> => {
    const url = `${base}/routing/v1/providers/${cid}`
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (res.status === 404) {
        notAnnounced += 1
        if (examples.length < 5) examples.push({ cid, reason: 'no providers (404)' })
        return
      }
      if (!res.ok) {
        notAnnounced += 1
        if (examples.length < 5) examples.push({ cid, reason: `HTTP ${res.status}` })
        return
      }
      const body = (await res.json()) as { Providers?: unknown[] } | unknown[]
      const providers = Array.isArray(body) ? body : Array.isArray(body.Providers) ? body.Providers : []
      if (providers.length === 0) {
        notAnnounced += 1
        if (examples.length < 5) examples.push({ cid, reason: 'empty provider list' })
      } else {
        announced += 1
      }
    } catch (err) {
      notAnnounced += 1
      const message = err instanceof Error ? err.message : String(err)
      if (examples.length < 5) examples.push({ cid, reason: message })
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, cids.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= cids.length) return
      await probeOne(cids[i])
    }
  })
  await Promise.all(workers)

  return { endpoint: base, probed: cids.length, population, announced, notAnnounced, examples }
}

/**
 * Materialize a deterministic stride sample of size `n` from the asset CIDs
 * of every committed aggregate, without ever holding the full list in
 * memory. Walk each aggregate only when its absolute index range intersects
 * a target sample index; load that aggregate's asset CIDs, extract the
 * hits, and drop the array.
 *
 * Stride sampling (rather than reservoir) keeps the choice reproducible
 * across `report` runs against the same DB — a re-run hits the same CIDs.
 *
 * Memory: O(n) for the output + O(memberCount) for the current aggregate's
 * temp array. For a 32 GiB aggregate of 512 KiB assets that's ~65k strings
 * (~4 MB) per aggregate, then released.
 */
function collectSample(
  db: MigrationDB,
  committedAggs: Array<{ idx: number; memberCount: number }>,
  population: number,
  n: number
): string[] {
  const sampleCount = !Number.isFinite(n) || n >= population ? population : Math.max(0, Math.floor(n))
  if (sampleCount === 0) return []

  const targets: number[] = new Array(sampleCount)
  const step = population / sampleCount
  for (let i = 0; i < sampleCount; i++) targets[i] = Math.floor(i * step)

  const out: string[] = []
  let absolute = 0
  let nextTarget = 0
  for (const agg of committedAggs) {
    if (nextTarget >= targets.length) break
    const end = absolute + agg.memberCount
    if (targets[nextTarget] < end) {
      const cids = db.aggregateAssetCids(agg.idx)
      while (nextTarget < targets.length && targets[nextTarget] < end) {
        out.push(cids[targets[nextTarget] - absolute])
        nextTarget++
      }
    }
    absolute = end
  }
  return out
}
