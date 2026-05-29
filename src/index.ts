#!/usr/bin/env node
/**
 * foc-migrate CLI.
 *
 * Subcommands:
 *   probe   <cid> [--gateway URL]...        Verify a gateway serves deterministic trustless CARs.
 *   commp   <cid> [--gateway URL]...        Fetch a CID as a CAR and print its PieceCID v2 + size.
 *   plan    --cids FILE [--db FILE] [opts]  Compute commitments + pack aggregates into the DB (resumable).
 *   status  [--db FILE]                     Report progress and the aggregate plan.
 *   serve   [--db FILE] [opts]              Background commP runner + dashboard.
 *   gas     [--network N] [opts]            Current network base fee and whether to pause.
 *   redirect-serve [--db FILE] [--port N] [--ingress funnel|cloudflared]   GET /piece/{pcidv2} -> 302 gateway CAR.
 *   create-data-set --provider-id ID [opts] Provision a new FWSS data set with withIPFSIndexing (PRIVATE_KEY env).
 *   pdp-submit --data-set-id ID [opts]      Pull, park, and add aggregates over PDP (PRIVATE_KEY env).
 *   report  --data-set-id ID [opts]         Reconcile a run against on-chain pieces; emit explorer links.
 *
 * stdout carries machine-readable output; logs go to stderr. State lives in a
 * sqlite DB (default ./migrate.db).
 */

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import {
  DEFAULT_PROBE_CONCURRENCY,
  DEFAULT_SAMPLE,
  formatAnalyzeText,
  runAnalyze,
} from './analyze.ts'
import { MigrationDB } from './db.ts'
import { classifyBaseFee, DEFAULT_MAX_BASE_FEE, getBaseFee, resolveRpcUrl } from './gas.ts'
import { DEFAULT_GATEWAYS, probeGateway } from './gateway.ts'
import { runCreateDataSet } from './create-data-set.ts'
import { explorerBase } from './pdp-verifier.ts'
import { startRedirectServer } from './redirect-server.ts'
import { startCloudflaredTunnel } from './redirect-server-cloudflared.ts'
import { runSubmitPdp } from './submit-pdp.ts'
import { runReport } from './report.ts'
import { runPlan } from './migrate.ts'
import { fetchAndComputePiece } from './piece.ts'
import { Runner } from './runner.ts'
import { startServer } from './server.ts'
import { log, parseCidList, parsePositiveInt, parseSize } from './util.ts'

const DEFAULT_DB = './migrate.db'

const USAGE = `foc-migrate — migrate pinned IPFS CIDs to FOC without re-chunking

Usage:
  foc-migrate probe  <cid> [--gateway URL]...
  foc-migrate commp  <cid> [--gateway URL]...
  foc-migrate plan   --cids <file> [--db <file>] [--gateway URL]... [--piece-size 32GiB]
                     [--concurrency 8]
  foc-migrate status [--db <file>] [--json]
  foc-migrate serve  [--db <file>] [--cids <file>] [--gateway URL]... [--piece-size 32GiB]
                     [--concurrency 8] [--port 4321] [--network mainnet|calibration] [--max-base-fee N]
  foc-migrate gas    [--network mainnet|calibration] [--rpc-url URL] [--max-base-fee N]
  foc-migrate redirect-serve [--db <file>] [--port 4322] [--ingress funnel|cloudflared]
  foc-migrate create-data-set --provider-id <id> [--network mainnet|calibration] [--cdn]
                     (uses PRIVATE_KEY env)
  foc-migrate pdp-submit --data-set-id <id> --source-base <https-url> [--db <file>]
                     [--network mainnet|calibration] [--max-in-flight 4] [--max-base-fee N] [--pull-batch 32]
                     (uses PRIVATE_KEY env)
  foc-migrate report --data-set-id <id> [--db <file>] [--network mainnet|calibration] [--json]
                     [--check-ipni <delegated-routing-url>] [--ipni-sample 100|--ipni-all] [--ipni-concurrency 8]
  foc-migrate analyze [--cids <file>] [--db <file>] [--car-store <dir>] [--gateway URL]
                     [--sample 100|--all] [--probe-concurrency 8] [--bw-target URL]
                     [--network mainnet|calibration] [--json]

Defaults:
  db          ${DEFAULT_DB}
  gateways    ${DEFAULT_GATEWAYS.join(', ')}
  piece-size  32GiB
  concurrency 8
  port        4321
  network     mainnet (serve base-fee monitor off unless --network or --rpc-url given)
`

function gatewaysFrom(values: { gateway?: string[] }): string[] {
  return values.gateway != null && values.gateway.length > 0 ? values.gateway : DEFAULT_GATEWAYS
}

async function cmdProbe(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { gateway: { type: 'string', multiple: true } },
  })
  const cid = positionals[0]
  if (cid == null) {
    throw new Error('probe requires a <cid>')
  }
  const results = []
  for (const gateway of gatewaysFrom(values)) {
    try {
      const r = await probeGateway(gateway, cid)
      log(
        `${r.deterministic ? 'OK  ' : 'WARN'} ${gateway} — CAR ${r.bytes} bytes, sha256 ${r.sha256.slice(0, 16)}…${
          r.deterministic ? ', deterministic' : ` — ${r.note}`
        }`
      )
      results.push(r)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`FAIL ${gateway} — ${message}`)
      results.push({ gateway, cid, servesCar: false, deterministic: false, error: message })
    }
  }
  console.log(JSON.stringify(results, null, 2))
}

async function cmdCommp(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { gateway: { type: 'string', multiple: true } },
  })
  const cid = positionals[0]
  if (cid == null) {
    throw new Error('commp requires a <cid>')
  }
  const piece = await fetchAndComputePiece(cid, gatewaysFrom(values))
  log(`${cid} -> ${piece.pieceCid} (${piece.rawSize} bytes via ${piece.gateway})`)
  console.log(JSON.stringify(piece, null, 2))
}

async function cmdPlan(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cids: { type: 'string' },
      db: { type: 'string', default: DEFAULT_DB },
      gateway: { type: 'string', multiple: true },
      'piece-size': { type: 'string', default: '32GiB' },
      concurrency: { type: 'string', default: '8' },
    },
  })
  if (values.cids == null) {
    throw new Error('plan requires --cids <file>')
  }
  const cids = parseCidList(await readFile(values.cids, 'utf8'))
  if (cids.length === 0) {
    throw new Error(`no CIDs found in ${values.cids}`)
  }

  const db = new MigrationDB(values.db as string)
  try {
    db.addCids(cids)
    const summary = await runPlan(db, {
      gateways: gatewaysFrom(values),
      aggregateSizeBytes: parseSize(values['piece-size'] as string),
      concurrency: parsePositiveInt(values.concurrency as string, '--concurrency'),
    })

    log('')
    log(`Done. ${summary.succeeded}/${summary.total} pieces, ${summary.aggregateCount} aggregate(s) -> ${values.db}`)
    if (summary.failed > 0) {
      log(`Failed: ${summary.failed} (run 'status' for details; re-run 'plan' to retry)`)
    }
    if (summary.oversized.length > 0) {
      log(
        `Oversized: ${summary.oversized.join(', ')} ` +
          `(piece padded size exceeds --piece-size aggregate budget). ` +
          `Pieces above the provider's per-piece pull limit (~1 GiB raw) cannot be migrated as one piece either.`
      )
    }
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    db.close()
  }
}

/** Schema version emitted in `status --json` so downstream scripts can detect breaking changes. */
const STATUS_JSON_SCHEMA_VERSION = 1

async function cmdStatus(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      json: { type: 'boolean', default: false },
    },
  })
  const db = new MigrationDB(values.db as string)
  try {
    const counts = db.counts()
    const aggregates = db.aggregates()
    const failures = db.failures()
    const failuresByCategory = db.failuresByCategory()
    const aggregatesByStatus = db.aggregatesByStatus()

    if (values.json === true) {
      // Pure machine-readable mode: stdout = JSON only, no human log lines.
      const payload = {
        schemaVersion: STATUS_JSON_SCHEMA_VERSION,
        counts,
        aggregatesByStatus,
        failuresByCategory,
        aggregates,
        failures,
      }
      console.log(JSON.stringify(payload, null, 2))
      return
    }

    log(`Pieces: ${counts.done} done, ${counts.pending} pending, ${counts.failed} failed`)
    for (const agg of aggregates) {
      const errSuffix = agg.error == null ? '' : ` — ${agg.error.split('\n')[0]}`
      log(`  aggregate ${agg.idx} [${agg.status}] ${agg.memberCount} member(s) root=${agg.rootPieceCid}${errSuffix}`)
    }
    if (Object.keys(failuresByCategory).length > 0) {
      const summary = Object.entries(failuresByCategory)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
      log(`Failures by category: ${summary}`)
    }
    if (failures.length > 0) {
      log(`Failures:`)
      for (const f of failures) {
        log(`  ${f.cid} [${f.category}]: ${f.error.split('\n')[0]}`)
      }
    }
  } finally {
    db.close()
  }
}

async function cmdReport(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      'data-set-id': { type: 'string' },
      network: { type: 'string', default: 'mainnet' },
      'rpc-url': { type: 'string' },
      'check-ipni': { type: 'string' },
      'ipni-sample': { type: 'string', default: '100' },
      'ipni-all': { type: 'boolean', default: false },
      'ipni-concurrency': { type: 'string', default: '8' },
      json: { type: 'boolean', default: false },
    },
  })
  if (values['data-set-id'] == null) {
    throw new Error('report requires --data-set-id <id>')
  }
  const network = values.network as 'calibration' | 'mainnet'

  const db = new MigrationDB(values.db as string)
  try {
    const report = await runReport(db, {
      network,
      rpcUrl: values['rpc-url'],
      dataSetId: parsePositiveInt(values['data-set-id'] as string, '--data-set-id'),
      ipniEndpoint: values['check-ipni'],
      ipniSample: values['ipni-all'] === true
        ? Infinity
        : parsePositiveInt(values['ipni-sample'] as string, '--ipni-sample'),
      ipniConcurrency: parsePositiveInt(values['ipni-concurrency'] as string, '--ipni-concurrency'),
    })
    if (values.json) {
      console.log(JSON.stringify(report, null, 2))
    }
    // Non-zero exit when the input accounting does not close. Operators wiring
    // `report` into CI / a final gate get a hard signal that the migration is
    // not yet done.
    if (report.cids.unaccounted > 0) {
      log(`error: ${report.cids.unaccounted} CID(s) unaccounted — refusing to declare complete`)
      process.exitCode = 1
    } else if (!report.complete) {
      // Pending or failed CIDs remain; not an error, but signal incomplete.
      process.exitCode = 2
    }
    if (!report.proof.live) {
      log(`error: data set ${report.dataSetId} is not live on chain`)
      process.exitCode = 1
    } else if (!report.proof.provenSinceAdd) {
      log(`warning: storage provider has not yet proven possession since the last AddPieces`)
      process.exitCode = process.exitCode ?? 2
    }
    if (report.ipni != null && report.ipni.notAnnounced > 0) {
      log(`warning: ${report.ipni.notAnnounced} CID(s) not announced to IPNI in the sample`)
      process.exitCode = process.exitCode ?? 2
    }
  } finally {
    db.close()
  }
}

async function cmdPdpSubmit(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      'data-set-id': { type: 'string' },
      'source-base': { type: 'string' },
      network: { type: 'string', default: 'mainnet' },
      'rpc-url': { type: 'string' },
      'max-in-flight': { type: 'string', default: '4' },
      'max-base-fee': { type: 'string' },
      'poll-seconds': { type: 'string', default: '15' },
      'pull-batch': { type: 'string', default: '32' },
    },
  })
  if (values['data-set-id'] == null) {
    throw new Error('pdp-submit requires --data-set-id <id>')
  }
  if (values['source-base'] == null) {
    throw new Error('pdp-submit requires --source-base <public https base of redirect-serve, e.g. https://host.ts.net>')
  }
  const key = process.env.PRIVATE_KEY
  if (key == null || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('set PRIVATE_KEY (0x + 64 hex) in the environment (e.g. `source .env`)')
  }
  const network = values.network as 'calibration' | 'mainnet'

  const db = new MigrationDB(values.db as string)
  try {
    await runSubmitPdp(db, {
      privateKey: key as `0x${string}`,
      network,
      rpcUrl: values['rpc-url'],
      dataSetId: parsePositiveInt(values['data-set-id'] as string, '--data-set-id'),
      sourceBase: values['source-base'] as string,
      maxInFlight: parsePositiveInt(values['max-in-flight'] as string, '--max-in-flight'),
      maxBaseFee: values['max-base-fee'] != null ? BigInt(values['max-base-fee']) : DEFAULT_MAX_BASE_FEE,
      pollMs: parsePositiveInt(values['poll-seconds'] as string, '--poll-seconds') * 1000,
      pullBatch: parsePositiveInt(values['pull-batch'] as string, '--pull-batch'),
    })
    const committed = db.aggregates().filter((a) => a.status === 'committed')
    log(`committed ${committed.length} aggregate(s). Confirm at ${explorerBase(network)} (data set ${values['data-set-id']})`)
    console.log(JSON.stringify({ dataSetId: values['data-set-id'], committed: committed.map((a) => ({ root: a.rootPieceCid, tx: a.txHash })) }, null, 2))
  } finally {
    db.close()
  }
}

async function cmdCreateDataSet(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'provider-id': { type: 'string' },
      network: { type: 'string', default: 'mainnet' },
      'rpc-url': { type: 'string' },
      cdn: { type: 'boolean', default: false },
      'timeout-seconds': { type: 'string', default: '600' },
    },
  })
  if (values['provider-id'] == null) {
    throw new Error('create-data-set requires --provider-id <id>')
  }
  const key = process.env.PRIVATE_KEY
  if (key == null || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('set PRIVATE_KEY (0x + 64 hex) in the environment (e.g. `source .env`)')
  }
  const result = await runCreateDataSet({
    privateKey: key as `0x${string}`,
    network: values.network as 'calibration' | 'mainnet',
    rpcUrl: values['rpc-url'],
    providerId: BigInt(values['provider-id'] as string),
    cdn: values.cdn === true,
    timeoutMs: parsePositiveInt(values['timeout-seconds'] as string, '--timeout-seconds') * 1000,
  })
  console.log(JSON.stringify(result, null, 2))
}

async function cmdRedirectServe(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      port: { type: 'string', default: '4322' },
      ingress: { type: 'string', default: 'funnel' },
    },
  })
  const db = new MigrationDB(values.db as string)
  const port = parsePositiveInt(values.port as string, '--port')
  const ingress = values.ingress as string
  if (ingress !== 'funnel' && ingress !== 'cloudflared') {
    throw new Error(`unknown --ingress ${ingress} (expected funnel|cloudflared)`)
  }
  startRedirectServer(db, port)
  if (ingress === 'cloudflared') {
    await startCloudflaredTunnel({ port })
  }
}

async function cmdGas(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      network: { type: 'string', default: 'mainnet' },
      'rpc-url': { type: 'string' },
      'max-base-fee': { type: 'string' },
    },
  })
  const rpcUrl = resolveRpcUrl({ rpcUrl: values['rpc-url'], network: values.network as string })
  const maxBaseFee = values['max-base-fee'] != null ? BigInt(values['max-base-fee']) : DEFAULT_MAX_BASE_FEE
  const reading = classifyBaseFee(await getBaseFee(rpcUrl), maxBaseFee)
  log(
    `baseFee ${reading.baseFee} attoFIL/gas (${reading.multipleOfFloor}x floor) — ${reading.level}` +
      (reading.pause ? ' — PAUSE submission' : '')
  )
  console.log(JSON.stringify({ rpcUrl, maxBaseFee: maxBaseFee.toString(), ...reading, baseFee: reading.baseFee.toString() }, null, 2))
}

async function cmdAnalyze(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cids: { type: 'string' },
      db: { type: 'string', default: DEFAULT_DB },
      'car-store': { type: 'string' },
      gateway: { type: 'string' },
      sample: { type: 'string', default: String(DEFAULT_SAMPLE) },
      all: { type: 'boolean', default: false },
      'probe-concurrency': { type: 'string', default: String(DEFAULT_PROBE_CONCURRENCY) },
      'bw-target': { type: 'string' },
      network: { type: 'string', default: 'mainnet' },
      json: { type: 'boolean', default: false },
    },
  })
  const network = values.network as string
  if (network !== 'mainnet' && network !== 'calibration') {
    throw new Error(`unknown --network ${network} (expected mainnet|calibration)`)
  }
  const report = await runAnalyze({
    cidsFile: values.cids,
    dbPath: values.db as string,
    carStorePath: values['car-store'],
    gateway: values.gateway ?? DEFAULT_GATEWAYS[0],
    sample: parsePositiveInt(values.sample as string, '--sample'),
    all: values.all === true,
    probeConcurrency: parsePositiveInt(values['probe-concurrency'] as string, '--probe-concurrency'),
    bwTarget: values['bw-target'],
    network,
  })
  if (values.json === true) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(formatAnalyzeText(report))
}

async function cmdServe(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      cids: { type: 'string' },
      gateway: { type: 'string', multiple: true },
      'piece-size': { type: 'string', default: '32GiB' },
      concurrency: { type: 'string', default: '8' },
      port: { type: 'string', default: '4321' },
      network: { type: 'string' },
      'rpc-url': { type: 'string' },
      'max-base-fee': { type: 'string' },
    },
  })

  const db = new MigrationDB(values.db as string)
  // Seed CIDs if a list was provided; otherwise add them later via the dashboard.
  if (values.cids != null) {
    db.addCids(parseCidList(await readFile(values.cids, 'utf8')))
  }

  const runner = new Runner(db, {
    gateways: gatewaysFrom(values),
    concurrency: parsePositiveInt(values.concurrency as string, '--concurrency'),
    aggregateSizeBytes: parseSize(values['piece-size'] as string),
  })

  // Enable base-fee monitoring on the dashboard when a network or RPC is given.
  const gas =
    values.network != null || values['rpc-url'] != null
      ? {
          rpcUrl: resolveRpcUrl({ rpcUrl: values['rpc-url'], network: values.network as string }),
          maxBaseFee: values['max-base-fee'] != null ? BigInt(values['max-base-fee']) : DEFAULT_MAX_BASE_FEE,
        }
      : undefined
  startServer(db, runner, parsePositiveInt(values.port as string, '--port'), gas)
  // Server keeps the process alive; the runner starts via the dashboard/API.
  log(`Loaded ${db.counts().pending} pending CID(s). Press Start in the dashboard (or POST /api/start).`)
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  switch (command) {
    case 'probe':
      await cmdProbe(rest)
      break
    case 'commp':
      await cmdCommp(rest)
      break
    case 'plan':
      await cmdPlan(rest)
      break
    case 'status':
      await cmdStatus(rest)
      break
    case 'serve':
      await cmdServe(rest)
      break
    case 'gas':
      await cmdGas(rest)
      break
    case 'redirect-serve':
      await cmdRedirectServe(rest)
      break
    case 'create-data-set':
      await cmdCreateDataSet(rest)
      break
    case 'pdp-submit':
      await cmdPdpSubmit(rest)
      break
    case 'report':
      await cmdReport(rest)
      break
    case 'analyze':
      await cmdAnalyze(rest)
      break
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(USAGE)
      break
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
      process.exitCode = 1
  }
}

main().catch((err) => {
  log(`error: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
