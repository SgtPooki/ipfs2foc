#!/usr/bin/env node
/**
 * ipfs2foc CLI.
 *
 * Subcommands:
 *   probe   <cid> [--gateway URL]...        Verify a gateway serves deterministic trustless CARs.
 *   commp   <cid> [--gateway URL]...        Fetch a CID as a CAR and print its PieceCID v2 + size.
 *   plan    --cids FILE [--db FILE] [opts]  Compute commitments + pack aggregates into the DB (resumable).
 *   import-manifest FILE [--db FILE] [opts] Load a browser-console run manifest as done pieces (recomputes nothing).
 *   export  [--db FILE] [--out FILE] [opts] Write the DB's prepared pieces as a run manifest (round-trips to the browser).
 *   status  [--db FILE]                     Report progress and the aggregate plan.
 *   serve   [--db FILE] [opts]              Background commP runner + dashboard.
 *   gas     [--network N] [opts]            Current network base fee and whether to pause.
 *   redirect-serve [--db FILE] [--port N] [--ingress funnel|cloudflared]   GET /piece/{pcidv2} -> 302 gateway CAR.
 *   create-data-set --provider-id ID [opts] Provision a new FWSS data set with withIPFSIndexing (PRIVATE_KEY env).
 *   pdp-submit --data-set-id ID [opts]      Pull, park, and add aggregates over PDP (PRIVATE_KEY env).
 *   report  --data-set-id ID [opts]         Reconcile a run against on-chain pieces; emit explorer links.
 *   pack-cars --car-store DIR [opts]        Assemble multi-root CARs for the multi-asset path.
 *   analyze  [--cids FILE] [opts]           Pre-flight a CID list against a gateway (pass rate, sizes, throughput).
 *   reset-failed-aggregates [opts]          Recovery: move `failed` aggregates back to `planned`.
 *   retry-unconfirmed-aggregates [opts]     Recovery: re-arm unconfirmed aggregates (verify on chain first).
 *
 * stdout carries machine-readable output; logs go to stderr. State lives in a
 * sqlite DB (default ./migrate.db).
 */

import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { DEFAULT_PROBE_CONCURRENCY, DEFAULT_SAMPLE, formatAnalyzeText, runAnalyze } from './analyze.ts'
import { runCreateDataSet } from './create-data-set.ts'
import { MigrationDB } from './db.ts'
import { buildExportManifest } from './export-manifest.ts'
import { classifyBaseFee, DEFAULT_MAX_BASE_FEE, getBaseFee, resolveRpcUrl } from './gas.ts'
import { DEFAULT_GATEWAYS, probeGateway } from './gateway.ts'
import { stopGatewayBlocks } from './gateway-blocks.ts'
import { stopHeliaFallback } from './helia-fallback.ts'
import { parseRunManifest, runImportManifest } from './import-manifest.ts'
import { runPlan } from './migrate.ts'
import { runPackCars } from './pack-cars.ts'
import { explorerBase } from './pdp-verifier.ts'
import { fetchAndComputePiece } from './piece.ts'
import { startRedirectServer } from './redirect-server.ts'
import { startCloudflaredTunnel } from './redirect-server-cloudflared.ts'
import { bigintJsonReplacer, runReport } from './report.ts'
import { Runner } from './runner.ts'
import { startServer } from './server.ts'
import { runSubmitPdp } from './submit-pdp.ts'
import { log, parseCidList, parsePositiveInt, parseSize } from './util.ts'

const DEFAULT_DB = './migrate.db'

const USAGE = `ipfs2foc — migrate pinned IPFS CIDs to FOC without re-chunking

Usage:
  ipfs2foc probe  <cid> [--gateway URL]...
  ipfs2foc commp  <cid> [--gateway URL]...
  ipfs2foc plan   --cids <file> [--db <file>] [--gateway URL]... [--piece-size 32GiB]
                     [--concurrency 8]
  ipfs2foc import-manifest <manifest.json> [--db <file>] [--network mainnet|calibration]
  ipfs2foc export [--db <file>] [--out <file>] [--network mainnet|calibration] [--source-relay <https-url>]
                     [--piece-size 32GiB] [--no-auto-pack]
  ipfs2foc status [--db <file>] [--json]
  ipfs2foc serve  [--db <file>] [--cids <file>] [--gateway URL]... [--piece-size 32GiB]
                     [--concurrency 8] [--port 4321] [--network mainnet|calibration] [--max-base-fee N]
  ipfs2foc gas    [--network mainnet|calibration] [--rpc-url URL] [--max-base-fee N]
  ipfs2foc redirect-serve [--db <file>] [--port 4322] [--ingress funnel|cloudflared]
  ipfs2foc create-data-set --provider-id <id> [--network mainnet|calibration] [--cdn]
                     (uses PRIVATE_KEY env)
  ipfs2foc pdp-submit --data-set-id <id> (--source-base <https-url> | --source-relay <https-url>) [--db <file>]
                     [--network mainnet|calibration] [--max-in-flight 4] [--max-base-fee N] [--pull-batch 32]
                     (--source-base: your own redirect-serve; --source-relay: a shared stateless relay, passthrough only)
                     (uses PRIVATE_KEY env)
  ipfs2foc report --data-set-id <id> [--db <file>] [--network mainnet|calibration] [--json]
                     [--check-ipni <delegated-routing-url>] [--ipni-sample 100|--ipni-all] [--ipni-concurrency 8]
  ipfs2foc pack-cars --car-store <dir> [--db <file>] [--gateway URL]...
                     [--pack-target-size 512MiB] [--fetch-concurrency 4]
  ipfs2foc reset-failed-aggregates [--db <file>] [--network mainnet|calibration]
  ipfs2foc retry-unconfirmed-aggregates [--db <file>] [--network mainnet|calibration]
  ipfs2foc analyze [--cids <file>] [--db <file>] [--car-store <dir>] [--gateway URL]
                     [--sample 100|--all] [--probe-concurrency 8] [--bw-target URL]
                     [--network mainnet|calibration] [--json]

Defaults:
  db          ${DEFAULT_DB}
  gateways    ${DEFAULT_GATEWAYS.join(', ')}
  piece-size  32GiB
  concurrency 8
  port        4321
  network     mainnet (serve base-fee monitor off unless --network or --rpc-url given)

Examples:
  # Pre-flight a gateway, then plan a CID list
  ipfs2foc probe <cid> --gateway https://trustless-gateway.link
  ipfs2foc plan --cids cids.txt

  # Serve sub-pieces (terminal A) and submit them (terminal B)
  ipfs2foc redirect-serve --ingress cloudflared --port 4322
  ipfs2foc pdp-submit --data-set-id 42 --source-base https://<public-host>

  # Confirm everything landed on chain
  ipfs2foc report --data-set-id 42

IPFS fallback (plan, commp, serve):
  --ipfs-fallback                    Enable embedded ipfs node to recover from source-gateway 5xx/429 (default: off; opt-in)
  --ipfs-fallback-mode MODE          Fallback ordering (default: gateway-first; only value supported in this release)
  --ipfs-fallback-timeout-seconds N  Per-CID upper bound on the fallback fetch (default: 120)

Docs: https://github.com/SgtPooki/ipfs2foc#readme
  Quickstart and troubleshooting in the README; operator profiles, gateways,
  and ingress setup under docs/.
`

/** Subcommands `main` dispatches, used for did-you-mean on a mistyped command. */
const KNOWN_COMMANDS = [
  'probe',
  'commp',
  'plan',
  'import-manifest',
  'export',
  'status',
  'serve',
  'gas',
  'redirect-serve',
  'create-data-set',
  'pdp-submit',
  'report',
  'pack-cars',
  'reset-failed-aggregates',
  'retry-unconfirmed-aggregates',
  'analyze',
]

/** Levenshtein edit distance between two short strings. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
    }
  }
  return d[a.length][b.length]
}

/** Closest known command within an edit distance of 3, or null if none is close. */
function suggestCommand(input: string): string | null {
  let best: string | null = null
  let bestDistance = Infinity
  for (const cmd of KNOWN_COMMANDS) {
    const dist = editDistance(input, cmd)
    if (dist < bestDistance) {
      bestDistance = dist
      best = cmd
    }
  }
  return bestDistance <= 3 ? best : null
}

function gatewaysFrom(values: { gateway?: string[] }): string[] {
  return values.gateway != null && values.gateway.length > 0 ? values.gateway : DEFAULT_GATEWAYS
}

/** Default per-CID fallback budget in seconds. Matches `helia-fallback.DEFAULT_FALLBACK_TIMEOUT_MS`. */
const DEFAULT_FALLBACK_SECONDS = 120

/** Parse the IPFS-fallback flag triple. Only `gateway-first` is shipped; `helia-first` is reserved. */
function fallbackFrom(values: {
  'ipfs-fallback'?: boolean
  'ipfs-fallback-mode'?: string
  'ipfs-fallback-timeout-seconds'?: string
}): { ipfsFallback: boolean; fallbackTimeoutMs: number } {
  const ipfsFallback = values['ipfs-fallback'] === true
  const mode = values['ipfs-fallback-mode'] ?? 'gateway-first'
  if (mode !== 'gateway-first') {
    throw new Error(`unknown --ipfs-fallback-mode ${mode} (expected gateway-first; helia-first is reserved)`)
  }
  const seconds =
    values['ipfs-fallback-timeout-seconds'] == null
      ? DEFAULT_FALLBACK_SECONDS
      : parsePositiveInt(values['ipfs-fallback-timeout-seconds'], '--ipfs-fallback-timeout-seconds')
  return { ipfsFallback, fallbackTimeoutMs: seconds * 1000 }
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
  if (results.some((r) => r.deterministic === true)) {
    log("Next: pre-flight a whole list with 'ipfs2foc analyze --cids <file>', then 'ipfs2foc plan --cids <file>'")
  }
  console.log(JSON.stringify(results, null, 2))
}

async function cmdCommp(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      gateway: { type: 'string', multiple: true },
      'ipfs-fallback': { type: 'boolean', default: false },
      'ipfs-fallback-mode': { type: 'string' },
      'ipfs-fallback-timeout-seconds': { type: 'string' },
    },
  })
  const cid = positionals[0]
  if (cid == null) {
    throw new Error('commp requires a <cid>')
  }
  const fallback = fallbackFrom(values)
  try {
    const piece = await fetchAndComputePiece(cid, gatewaysFrom(values), fallback)
    log(`${cid} -> ${piece.pieceCid} (${piece.rawSize} bytes via ${piece.gateway})`)
    console.log(JSON.stringify(piece, null, 2))
  } finally {
    await stopHeliaFallback()
    await stopGatewayBlocks()
  }
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
      'ipfs-fallback': { type: 'boolean', default: false },
      'ipfs-fallback-mode': { type: 'string' },
      'ipfs-fallback-timeout-seconds': { type: 'string' },
      'no-auto-pack': { type: 'boolean', default: false },
    },
  })
  if (values.cids == null) {
    throw new Error('plan requires --cids <file>')
  }
  const fallback = fallbackFrom(values)
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
      ipfsFallback: fallback.ipfsFallback,
      fallbackTimeoutMs: fallback.fallbackTimeoutMs,
      autoPack: values['no-auto-pack'] !== true,
    })

    log('')
    log(`Done. ${summary.succeeded}/${summary.total} pieces, ${summary.aggregateCount} aggregate(s) -> ${values.db}`)
    if (summary.succeeded > 0) {
      log(
        "Next: serve sub-pieces with 'ipfs2foc redirect-serve', then 'ipfs2foc pdp-submit --data-set-id <id> --source-base <url>'"
      )
    }
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
    await stopHeliaFallback()
    await stopGatewayBlocks()
  }
}

async function cmdImportManifest(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      network: { type: 'string', default: 'mainnet' },
      'piece-size': { type: 'string', default: '32GiB' },
      'no-auto-pack': { type: 'boolean', default: false },
    },
  })
  const file = positionals[0]
  if (file == null) {
    throw new Error(
      'import-manifest requires a <manifest.json> (saved by the browser console via "Download run manifest")'
    )
  }
  const network = values.network as string
  if (network !== 'mainnet' && network !== 'calibration') {
    throw new Error(`unknown --network ${network} (expected mainnet|calibration)`)
  }
  const manifest = parseRunManifest(await readFile(file, 'utf8'))
  log(`network: ${network}; manifest network: ${manifest.network}, gateway: ${manifest.gateway}`)

  const db = new MigrationDB(values.db as string)
  try {
    const summary = runImportManifest(db, manifest, {
      network,
      aggregateSizeBytes: parseSize(values['piece-size'] as string),
      autoPack: values['no-auto-pack'] !== true,
    })
    log(
      `Imported ${summary.imported} piece(s) (${summary.alreadyRecorded} already recorded), ` +
        `${summary.aggregateCount} aggregate(s) -> ${values.db}`
    )
    if (summary.imported > 0 || summary.alreadyRecorded > 0) {
      const relay = manifest.relayBase ?? '<relay-base-url>'
      log(
        `Next: 'ipfs2foc pdp-submit --data-set-id <id> --source-relay ${relay} --network ${network}' ` +
          `(PRIVATE_KEY env; create-data-set first if you have no data set)`
      )
    }
    if (summary.oversized.length > 0) {
      log(`Oversized: ${summary.oversized.join(', ')} (piece padded size exceeds --piece-size aggregate budget)`)
    }
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    db.close()
  }
}

async function cmdExport(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      network: { type: 'string', default: 'mainnet' },
      'source-relay': { type: 'string' },
      out: { type: 'string' },
    },
  })
  const network = values.network as string
  if (network !== 'mainnet' && network !== 'calibration') {
    throw new Error(`unknown --network ${network} (expected mainnet|calibration)`)
  }

  const db = new MigrationDB(values.db as string)
  try {
    const { manifest, excludedOversized } = buildExportManifest(db, {
      network,
      relayBase: values['source-relay'] as string | undefined,
      now: new Date().toISOString(),
    })
    const json = JSON.stringify(manifest, null, 2)
    const out = values.out as string | undefined
    if (out == null) {
      // No --out: the manifest is the command's output, so it pipes to a file or
      // another tool. Progress goes to stderr (log) to keep stdout clean JSON.
      log(`Exported ${manifest.pieces.length} piece(s) (network ${network}, gateway ${manifest.gateway})`)
      console.log(json)
    } else {
      await writeFile(out, `${json}\n`)
      log(`Exported ${manifest.pieces.length} piece(s) (network ${network}, gateway ${manifest.gateway}) -> ${out}`)
    }
    if (excludedOversized > 0) {
      log(
        `Note: ${excludedOversized} oversized piece(s) were excluded (padded size exceeds this run's --piece-size). ` +
          `Re-pack with a larger --piece-size before exporting if they belong in this manifest.`
      )
    }
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
      'allow-unaccounted': { type: 'boolean', default: false },
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
      ipniSample:
        values['ipni-all'] === true ? Infinity : parsePositiveInt(values['ipni-sample'] as string, '--ipni-sample'),
      ipniConcurrency: parsePositiveInt(values['ipni-concurrency'] as string, '--ipni-concurrency'),
    })
    if (values.json) {
      console.log(JSON.stringify(report, bigintJsonReplacer, 2))
    }
    if (report.unaccountedOnChain.length > 0) {
      log(
        `error: ${report.unaccountedOnChain.length} piece(s) on chain are not tracked in the local DB ` +
          `(first: ${report.unaccountedOnChain[0]})` +
          (values['allow-unaccounted'] === true ? ' — continuing because --allow-unaccounted is set' : '')
      )
      if (values['allow-unaccounted'] !== true) process.exitCode = 1
    }
    // Non-zero exit when the input accounting does not close. Operators wiring
    // `report` into CI / a final gate get a hard signal that the migration is
    // not yet done.
    if (report.cids.unaccounted > 0) {
      log(`error: ${report.cids.unaccounted} CID(s) unaccounted — refusing to declare complete`)
      process.exitCode = 1
    } else if (!report.complete) {
      // Pending or failed CIDs remain; not an error, but signal incomplete.
      process.exitCode = process.exitCode ?? 2
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
      'source-relay': { type: 'string' },
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
  if ((values['source-base'] == null) === (values['source-relay'] == null)) {
    throw new Error(
      'pdp-submit requires exactly one of --source-base <https base of your redirect-serve> ' +
        'or --source-relay <https base of a stateless redirect relay, e.g. https://ipfs2foc-relay.<sub>.workers.dev>'
    )
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
      sourceBase: values['source-base'] as string | undefined,
      sourceRelay: values['source-relay'] as string | undefined,
      maxInFlight: parsePositiveInt(values['max-in-flight'] as string, '--max-in-flight'),
      maxBaseFee: values['max-base-fee'] == null ? DEFAULT_MAX_BASE_FEE : BigInt(values['max-base-fee']),
      pollMs: parsePositiveInt(values['poll-seconds'] as string, '--poll-seconds') * 1000,
      pullBatch: parsePositiveInt(values['pull-batch'] as string, '--pull-batch'),
    })
    const committed = db.aggregates().filter((a) => a.status === 'committed')
    log(
      `committed ${committed.length} aggregate(s). Confirm at ${explorerBase(network)} (data set ${values['data-set-id']})`
    )
    log(`Next: 'ipfs2foc report --data-set-id ${values['data-set-id']}' to reconcile against the on-chain pieces`)
    console.log(
      JSON.stringify(
        { dataSetId: values['data-set-id'], committed: committed.map((a) => ({ root: a.rootPieceCid, tx: a.txHash })) },
        null,
        2
      )
    )
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
  log(
    `Next: 'ipfs2foc plan --cids <file>', then 'ipfs2foc pdp-submit --data-set-id ${result.dataSetId} --source-base <url>'`
  )
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
  const maxBaseFee = values['max-base-fee'] == null ? DEFAULT_MAX_BASE_FEE : BigInt(values['max-base-fee'])
  const reading = classifyBaseFee(await getBaseFee(rpcUrl), maxBaseFee)
  log(
    `baseFee ${reading.baseFee} attoFIL/gas (${reading.multipleOfFloor}x floor) — ${reading.level}` +
      (reading.pause ? ' — PAUSE submission' : '')
  )
  console.log(
    JSON.stringify(
      { rpcUrl, maxBaseFee: maxBaseFee.toString(), ...reading, baseFee: reading.baseFee.toString() },
      null,
      2
    )
  )
}

async function cmdPackCars(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      gateway: { type: 'string', multiple: true },
      'car-store': { type: 'string' },
      'pack-target-size': { type: 'string', default: '512MiB' },
      'fetch-concurrency': { type: 'string', default: '4' },
    },
  })
  if (values['car-store'] == null) {
    throw new Error('pack-cars requires --car-store <dir> (assembled CARs are persisted here)')
  }
  const targetSizeBytes = Number(parseSize(values['pack-target-size'] as string))
  const db = new MigrationDB(values.db as string)
  try {
    const summary = await runPackCars(db, {
      gateways: gatewaysFrom(values),
      targetSizeBytes,
      carStore: values['car-store'] as string,
      fetchConcurrency: parsePositiveInt(values['fetch-concurrency'] as string, '--fetch-concurrency'),
    })
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    db.close()
  }
}

async function cmdResetFailedAggregates(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      network: { type: 'string', default: 'mainnet' },
    },
  })
  const network = values.network as string
  if (network !== 'mainnet' && network !== 'calibration') {
    throw new Error(`unknown --network ${network} (expected mainnet|calibration)`)
  }
  const db = new MigrationDB(values.db as string)
  try {
    const changed = db.resetFailedAggregates()
    log(`reset ${changed} failed aggregate(s) back to planned (network=${network})`)
    console.log(JSON.stringify({ network, reset: changed }, null, 2))
  } finally {
    db.close()
  }
}

async function cmdRetryUnconfirmedAggregates(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      network: { type: 'string', default: 'mainnet' },
    },
  })
  const network = values.network as string
  if (network !== 'mainnet' && network !== 'calibration') {
    throw new Error(`unknown --network ${network} (expected mainnet|calibration)`)
  }
  const db = new MigrationDB(values.db as string)
  try {
    // Only run this after confirming on chain that the aggregate's root is
    // absent — re-arming an add whose tx actually landed lands a duplicate.
    const changed = db.resetUnconfirmedAggregates()
    log(`re-armed ${changed} unconfirmed aggregate(s) back to planned (network=${network})`)
    log('Only do this after verifying on chain that their roots are NOT present.')
    console.log(JSON.stringify({ network, retried: changed }, null, 2))
  } finally {
    db.close()
  }
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
      'ipfs-fallback': { type: 'boolean', default: false },
      'ipfs-fallback-mode': { type: 'string' },
      'ipfs-fallback-timeout-seconds': { type: 'string' },
    },
  })

  const db = new MigrationDB(values.db as string)
  // Seed CIDs if a list was provided; otherwise add them later via the dashboard.
  if (values.cids != null) {
    db.addCids(parseCidList(await readFile(values.cids, 'utf8')))
  }

  const fallback = fallbackFrom(values)
  const runner = new Runner(db, {
    gateways: gatewaysFrom(values),
    concurrency: parsePositiveInt(values.concurrency as string, '--concurrency'),
    aggregateSizeBytes: parseSize(values['piece-size'] as string),
    ipfsFallback: fallback.ipfsFallback,
    fallbackTimeoutMs: fallback.fallbackTimeoutMs,
  })

  // Enable base-fee monitoring on the dashboard when a network or RPC is given.
  const gas =
    values.network != null || values['rpc-url'] != null
      ? {
          rpcUrl: resolveRpcUrl({ rpcUrl: values['rpc-url'], network: values.network as string }),
          maxBaseFee: values['max-base-fee'] == null ? DEFAULT_MAX_BASE_FEE : BigInt(values['max-base-fee']),
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
    case 'import-manifest':
      await cmdImportManifest(rest)
      break
    case 'export':
      await cmdExport(rest)
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
    case 'pack-cars':
      await cmdPackCars(rest)
      break
    case 'reset-failed-aggregates':
      await cmdResetFailedAggregates(rest)
      break
    case 'retry-unconfirmed-aggregates':
      await cmdRetryUnconfirmedAggregates(rest)
      break
    case 'analyze':
      await cmdAnalyze(rest)
      break
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(USAGE)
      break
    default: {
      const suggestion = suggestCommand(command)
      const hint = suggestion == null ? '' : ` Did you mean '${suggestion}'?`
      process.stderr.write(`unknown command: ${command}.${hint}\n\n${USAGE}`)
      process.exitCode = 1
    }
  }
}

main().catch((err) => {
  log(`error: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
