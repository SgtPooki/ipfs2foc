#!/usr/bin/env node
/**
 * foc-migrate — Mode A CLI.
 *
 * Subcommands:
 *   probe  <cid> [--gateway URL]...                 Verify a gateway serves deterministic trustless CARs.
 *   commp  <cid> [--gateway URL]...                 Fetch a CID as a CAR and print its PieceCID v2 + size.
 *   plan   --cids FILE [--db FILE] [options]        Compute commitments + pack aggregates into the DB (resumable).
 *   status [--db FILE]                              Report progress and the aggregate plan.
 *   export [--db FILE] [--aggregate N] [--out DIR]  Emit sptool manifest(s) from the DB.
 *
 * stdout carries machine-readable output; logs go to stderr. State lives in a
 * sqlite DB (default ./migrate.db) — no JSON state files.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createCurioSigner } from './curio-auth.ts'
import { MigrationDB } from './db.ts'
import { classifyBaseFee, DEFAULT_MAX_BASE_FEE, getBaseFee, resolveRpcUrl } from './gas.ts'
import { DEFAULT_GATEWAYS, probeGateway } from './gateway.ts'
import { Mk20Client } from './mk20.ts'
import { startRedirectServer } from './redirect-server.ts'
import { runSubmitPdp } from './submit-pdp.ts'
import { explorerBase, pollSubmitted, runSubmit } from './submit.ts'
import { exportManifest, runPlan } from './migrate.ts'
import { fetchAndComputePiece } from './piece.ts'
import { Runner } from './runner.ts'
import { startServer } from './server.ts'
import { log, parseCidList, parseSize } from './util.ts'

const DEFAULT_DB = './migrate.db'

const USAGE = `foc-migrate — migrate pinned IPFS CIDs to FOC without re-chunking (Mode A)

Usage:
  foc-migrate probe  <cid> [--gateway URL]...
  foc-migrate commp  <cid> [--gateway URL]...
  foc-migrate plan   --cids <file> [--db <file>] [--gateway URL]... [--piece-size 32GiB]
                     [--concurrency 8]
  foc-migrate status [--db <file>]
  foc-migrate export [--db <file>] [--aggregate <n>] [--out ./out]
  foc-migrate serve  [--db <file>] [--cids <file>] [--gateway URL]... [--piece-size 32GiB]
                     [--concurrency 8] [--port 4321] [--network calibration] [--max-base-fee N]
  foc-migrate auth-check --provider <mk20 base url>     (uses PRIVATE_KEY env)
  foc-migrate gas    [--network mainnet|calibration] [--rpc-url URL] [--max-base-fee N]
  foc-migrate submit --data-set-id <id> [--db <file>] [--network calibration]
                     [--max-in-flight 4] [--max-base-fee N] [--no-indexing] [--no-announce]
                     (uses PRIVATE_KEY env)

Defaults:
  db          ${DEFAULT_DB}
  gateways    ${DEFAULT_GATEWAYS.join(', ')}
  piece-size  32GiB
  concurrency 8
  port        4321
  network     (serve: base-fee monitor off unless --network or --rpc-url given)

Submit an aggregate with Curio sptool (handles wallet auth):
  sptool toolbox mk20-client <add-piece-cmd> --aggregate <manifest.tsv> \\
    --pcidv2 <rootPieceCid from 'status'> --indexing --announce ...
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
      concurrency: Number.parseInt(values.concurrency as string, 10),
    })

    log('')
    log(`Done. ${summary.succeeded}/${summary.total} pieces, ${summary.aggregateCount} aggregate(s) -> ${values.db}`)
    if (summary.failed > 0) {
      log(`Failed: ${summary.failed} (run 'status' for details; re-run 'plan' to retry)`)
    }
    if (summary.oversized.length > 0) {
      log(`Oversized (need larger --piece-size): ${summary.oversized.join(', ')}`)
    }
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    db.close()
  }
}

async function cmdStatus(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { db: { type: 'string', default: DEFAULT_DB } } })
  const db = new MigrationDB(values.db as string)
  try {
    const counts = db.counts()
    const aggregates = db.aggregates()
    log(`Pieces: ${counts.done} done, ${counts.pending} pending, ${counts.failed} failed`)
    for (const agg of aggregates) {
      log(`  aggregate ${agg.idx} [${agg.status}] ${agg.memberCount} member(s) root=${agg.rootPieceCid}`)
    }
    const failures = db.failures()
    if (failures.length > 0) {
      log(`Failures:`)
      for (const f of failures) {
        log(`  ${f.cid}: ${f.error.split('\n')[0]}`)
      }
    }
    console.log(JSON.stringify({ counts, aggregates, failures }, null, 2))
  } finally {
    db.close()
  }
}

async function cmdExport(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      aggregate: { type: 'string' },
      out: { type: 'string', default: './out' },
    },
  })
  const db = new MigrationDB(values.db as string)
  try {
    await mkdir(values.out as string, { recursive: true })
    const indices =
      values.aggregate != null ? [Number.parseInt(values.aggregate, 10)] : db.aggregates().map((a) => a.idx)
    if (indices.length === 0) {
      throw new Error('no aggregates to export — run plan first')
    }
    const written: string[] = []
    for (const idx of indices) {
      const file = join(values.out as string, `aggregate-${idx}.tsv`)
      await writeFile(file, exportManifest(db, idx))
      written.push(file)
      const root = db.aggregates().find((a) => a.idx === idx)?.rootPieceCid
      log(`wrote ${file}  (--pcidv2 ${root})`)
    }
    console.log(JSON.stringify({ written }, null, 2))
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
      network: { type: 'string', default: 'calibration' },
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
      dataSetId: Number.parseInt(values['data-set-id'] as string, 10),
      sourceBase: values['source-base'] as string,
      maxInFlight: Number.parseInt(values['max-in-flight'] as string, 10),
      maxBaseFee: values['max-base-fee'] != null ? BigInt(values['max-base-fee']) : DEFAULT_MAX_BASE_FEE,
      pollMs: Number.parseInt(values['poll-seconds'] as string, 10) * 1000,
      pullBatch: Number.parseInt(values['pull-batch'] as string, 10),
    })
    const committed = db.aggregates().filter((a) => a.status === 'committed')
    log(`committed ${committed.length} aggregate(s). Confirm at ${explorerBase(network)} (data set ${values['data-set-id']})`)
    console.log(JSON.stringify({ dataSetId: values['data-set-id'], committed: committed.map((a) => ({ root: a.rootPieceCid, tx: a.txHash })) }, null, 2))
  } finally {
    db.close()
  }
}

async function cmdRedirectServe(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { db: { type: 'string', default: DEFAULT_DB }, port: { type: 'string', default: '4322' } },
  })
  const db = new MigrationDB(values.db as string)
  startRedirectServer(db, Number.parseInt(values.port as string, 10))
}

async function cmdSubmit(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      'data-set-id': { type: 'string' },
      network: { type: 'string', default: 'calibration' },
      'rpc-url': { type: 'string' },
      'max-in-flight': { type: 'string', default: '4' },
      'max-base-fee': { type: 'string' },
      'no-indexing': { type: 'boolean', default: false },
      'no-announce': { type: 'boolean', default: false },
      'poll-seconds': { type: 'string', default: '20' },
    },
  })
  if (values['data-set-id'] == null) {
    throw new Error('submit requires --data-set-id <id>')
  }
  const key = process.env.PRIVATE_KEY
  if (key == null || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('set PRIVATE_KEY (0x + 64 hex) in the environment (e.g. `source .env`)')
  }
  const network = values.network as 'calibration' | 'mainnet'

  const db = new MigrationDB(values.db as string)
  try {
    const ctx = await runSubmit(db, {
      privateKey: key as `0x${string}`,
      network,
      rpcUrl: values['rpc-url'],
      dataSetId: Number.parseInt(values['data-set-id'] as string, 10),
      maxInFlight: Number.parseInt(values['max-in-flight'] as string, 10),
      maxBaseFee: values['max-base-fee'] != null ? BigInt(values['max-base-fee']) : DEFAULT_MAX_BASE_FEE,
      indexing: !values['no-indexing'],
      announce: !values['no-announce'],
    })

    // Poll submitted aggregates to committed/failed.
    const intervalMs = Number.parseInt(values['poll-seconds'] as string, 10) * 1000
    let inFlight = db.inFlightUncommittedCount()
    while (inFlight > 0) {
      await new Promise((r) => setTimeout(r, intervalMs))
      inFlight = await pollSubmitted(ctx)
    }

    const committed = db.aggregates().filter((a) => a.status === 'committed')
    log(`committed ${committed.length} aggregate(s). Confirm at ${explorerBase(network)} (data set ${ctx.dataSetId})`)
    console.log(JSON.stringify({ dataSetId: ctx.dataSetId, committed: committed.map((a) => a.rootPieceCid), explorer: explorerBase(network) }, null, 2))
  } finally {
    db.close()
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

async function cmdAuthCheck(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { provider: { type: 'string' } } })
  if (values.provider == null) {
    throw new Error('auth-check requires --provider <mk20 base url>')
  }
  const key = process.env.PRIVATE_KEY
  if (key == null || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('set PRIVATE_KEY (0x + 64 hex) in the environment (e.g. `source .env`)')
  }

  const signer = createCurioSigner(key as `0x${string}`)
  log(`signing as eth address ${signer.address}`)
  const client = new Mk20Client(values.provider as string, signer)
  const contracts = await client.contracts()
  log(`CurioAuth accepted by ${values.provider} — DDO contracts: ${contracts.join(', ') || '(none)'}`)
  console.log(JSON.stringify({ provider: values.provider, address: signer.address, contracts }, null, 2))
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
    concurrency: Number.parseInt(values.concurrency as string, 10),
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
  startServer(db, runner, Number.parseInt(values.port as string, 10), gas)
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
    case 'export':
      await cmdExport(rest)
      break
    case 'serve':
      await cmdServe(rest)
      break
    case 'auth-check':
      await cmdAuthCheck(rest)
      break
    case 'gas':
      await cmdGas(rest)
      break
    case 'submit':
      await cmdSubmit(rest)
      break
    case 'redirect-serve':
      await cmdRedirectServe(rest)
      break
    case 'pdp-submit':
      await cmdPdpSubmit(rest)
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
