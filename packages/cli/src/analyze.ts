/**
 * Host + source-gateway + workload probe.
 *
 * `analyze` reads-only: it samples signals operators would otherwise have to
 * eyeball against `docs/personas.md`, picks the first matching persona, and
 * prints concrete flags plus warnings. No DB writes, no filesystem mutation.
 *
 * Signals collected:
 *   - Disk free on the `--db` and `--car-store` partitions (fs.statfs).
 *   - Source-gateway determinism over a CID stride sample (reuses probeGateway).
 *   - Estimated total CAR size, extrapolated from HEAD probes over the sample.
 *   - Runtime versions (node, sqlite, os.release).
 *   - Optional sustained-upload throughput against `--bw-target URL`.
 *   - Existing DB state if present (pending, done, failed, aggregates).
 *
 * Memory-aware: the CID list is streamed line-by-line; only the stride sample is
 * held in RAM. At a million CIDs the resident set stays bounded by `--sample N`.
 */

import { createReadStream, statSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { platform as osPlatform, release as osRelease } from 'node:os'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { MigrationDB } from './db.ts'
import { probeGateway } from './gateway.ts'
import { log, pool } from './util.ts'

const GIB = 1024 ** 3

/** Defaults match `skills/sensible-defaults.md`. */
export const DEFAULT_SAMPLE = 100
export const DEFAULT_PROBE_CONCURRENCY = 8
/** Below this success rate the source gateway is too flaky to recommend stream-only. */
export const PROBE_FAILURE_THRESHOLD = 0.05

export interface PersonaFlags {
  maxInFlight: number
  pieceSize: string
  pullBatch: number
  ingress: 'funnel' | 'cloudflared'
  carStore: 'recommended' | 'required' | 'stream-only'
}

export interface PersonaMatch {
  name: string
  reasons: string[]
  flags: PersonaFlags
}

export interface DiskReading {
  path: string
  freeBytes: number
  totalBytes: number
}

export interface ProbeSampleResult {
  cid: string
  ok: boolean
  deterministic: boolean
  bytes: number | null
  latencyMs: number | null
  error?: string
}

export interface BandwidthReading {
  target: string
  bytesSent: number
  durationMs: number
  mbitPerSecond: number
}

export interface AnalyzeReport {
  network: 'mainnet' | 'calibration'
  runtime: {
    node: string
    os: string
    platform: string
    sqliteVersion: string
  }
  input: {
    cidsFile: string | null
    sampledCount: number
    totalCount: number
    estimatedTotalSizeBytes: number | null
  }
  disk: DiskReading[]
  sourceGateway: {
    gateway: string
    probes: ProbeSampleResult[]
    successRate: number
    deterministicRate: number
    latencyP50Ms: number | null
  } | null
  bandwidth: BandwidthReading | null
  existingDb: {
    path: string
    pieces: { pending: number; done: number; failed: number; oversized: number; total: number }
    aggregatesByStatus: Record<string, number>
  } | null
  persona: PersonaMatch
  warnings: string[]
}

export interface AnalyzeOptions {
  cidsFile?: string
  dbPath?: string
  carStorePath?: string
  gateway: string
  sample: number
  all: boolean
  probeConcurrency: number
  bwTarget?: string
  network: 'mainnet' | 'calibration'
}

/**
 * Walk a CID list one line at a time and emit a stride sample. Reads only the
 * lines that land on a stride offset into memory, so a 10M-CID file does not
 * inflate RSS.
 */
export async function strideSampleCidFile(
  path: string,
  sampleSize: number,
  all: boolean
): Promise<{ sample: string[]; total: number }> {
  const total = await countCidLines(path)
  if (total === 0) {
    return { sample: [], total: 0 }
  }
  const targets = new Set<number>()
  if (all) {
    for (let i = 0; i < total; i++) targets.add(i)
  } else {
    const n = Math.min(sampleSize, total)
    for (let i = 0; i < n; i++) {
      targets.add(Math.floor((i * total) / n))
    }
  }
  const sample: string[] = []
  let index = 0
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const raw of rl) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (targets.has(index)) sample.push(line)
    index++
    if (sample.length === targets.size) break
  }
  return { sample, total }
}

async function countCidLines(path: string): Promise<number> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  let n = 0
  for await (const raw of rl) {
    const line = raw.trim()
    if (line !== '' && !line.startsWith('#')) n++
  }
  return n
}

async function diskFree(path: string): Promise<DiskReading | null> {
  try {
    const target = await firstExistingAncestor(path)
    const stats = await statfs(target)
    return {
      path: target,
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    }
  } catch {
    return null
  }
}

async function firstExistingAncestor(p: string): Promise<string> {
  let current = resolve(p)
  // walk up until a path exists; statfs needs an existing path.
  for (let i = 0; i < 16; i++) {
    try {
      statSync(current)
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
  return current
}

async function probeOne(gateway: string, cid: string): Promise<ProbeSampleResult> {
  const start = performance.now()
  try {
    const r = await probeGateway(gateway, cid)
    return {
      cid,
      ok: r.servesCar,
      deterministic: r.deterministic,
      bytes: r.bytes,
      latencyMs: Math.round(performance.now() - start),
    }
  } catch (err) {
    return {
      cid,
      ok: false,
      deterministic: false,
      bytes: null,
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]
}

/**
 * Measure sustained upload throughput by POSTing a fixed buffer of random
 * bytes. Caller chooses the target; default is to skip.
 */
export async function measureBandwidth(target: string, bytes = 4 * 1024 * 1024): Promise<BandwidthReading> {
  const payload = new Uint8Array(bytes)
  // pseudo-random so any compression on the wire does not lie about throughput
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) & 0xff
  const start = performance.now()
  const res = await fetch(target, { method: 'POST', body: payload })
  // drain the response body to include the full round trip
  await res.arrayBuffer()
  const durationMs = performance.now() - start
  const mbitPerSecond = (bytes * 8) / (durationMs / 1000) / 1_000_000
  return { target, bytesSent: bytes, durationMs, mbitPerSecond }
}

/**
 * Pick the first persona whose constraints all hold. Order matches
 * `docs/personas.md`: laptop, smb, production, bandwidth-bound.
 *
 * Pure function so it can be unit-tested without touching the network.
 */
export function matchPersona(input: {
  totalAssets: number
  estimatedTotalBytes: number | null
  carStoreFreeBytes: number | null
  bandwidthMbit: number | null
}): PersonaMatch {
  const { totalAssets, estimatedTotalBytes, carStoreFreeBytes, bandwidthMbit } = input
  const free = carStoreFreeBytes ?? 0
  const sizeGiB = estimatedTotalBytes == null ? null : estimatedTotalBytes / GIB

  // Laptop tester: tiny job, tight disk.
  if (totalAssets <= 1000 && (sizeGiB == null || sizeGiB < 5)) {
    return {
      name: 'Laptop tester',
      reasons: [
        'CID count ≤ 1000',
        sizeGiB == null ? 'size unknown, treated as small' : `estimated ${sizeGiB.toFixed(1)} GiB`,
      ],
      flags: { maxInFlight: 1, pieceSize: '32GiB', pullBatch: 32, ingress: 'cloudflared', carStore: 'recommended' },
    }
  }

  // Bandwidth-bound: slow upload regardless of catalog size.
  if (bandwidthMbit != null && bandwidthMbit < 50) {
    return {
      name: 'Bandwidth-bound migrator',
      reasons: [`measured upload ${bandwidthMbit.toFixed(0)} Mbit/s below 50 Mbit/s`],
      flags: { maxInFlight: 1, pieceSize: '32GiB', pullBatch: 32, ingress: 'funnel', carStore: 'recommended' },
    }
  }

  // Production migrator: large catalog with room to run four aggregates.
  if (totalAssets >= 100_000 && free >= 4 * 32 * GIB) {
    return {
      name: 'Production migrator',
      reasons: [
        `CID count ${totalAssets.toLocaleString()} ≥ 100k`,
        `car-store free ${(free / GIB).toFixed(0)} GiB ≥ 128 GiB`,
      ],
      flags: { maxInFlight: 4, pieceSize: '32GiB', pullBatch: 32, ingress: 'funnel', carStore: 'recommended' },
    }
  }

  // SMB / small studio fallback.
  return {
    name: 'SMB / small studio',
    reasons: ['default profile when no other persona constraints match'],
    flags: { maxInFlight: 1, pieceSize: '32GiB', pullBatch: 32, ingress: 'funnel', carStore: 'recommended' },
  }
}

/**
 * Apply cache-mode rules from the issue body.
 * Returns the persona with `carStore` adjusted, plus any warnings.
 */
export function applyCacheHeuristic(
  persona: PersonaMatch,
  signals: { carStoreFreeBytes: number | null; probeFailureRate: number }
): { persona: PersonaMatch; warnings: string[] } {
  const warnings: string[] = []
  const headroom = 10 * GIB
  const required = persona.flags.maxInFlight * 32 * GIB + headroom
  const free = signals.carStoreFreeBytes

  if (signals.probeFailureRate > PROBE_FAILURE_THRESHOLD) {
    warnings.push(
      `source-gateway failure rate ${(signals.probeFailureRate * 100).toFixed(0)}% exceeds ${(PROBE_FAILURE_THRESHOLD * 100).toFixed(0)}%; cached sub-piece path required`
    )
    return { persona: { ...persona, flags: { ...persona.flags, carStore: 'required' } }, warnings }
  }

  if (free == null) {
    warnings.push('car-store free space unknown; cannot confirm cache headroom')
    return { persona, warnings }
  }

  if (free >= required) {
    return { persona, warnings }
  }

  warnings.push(
    `car-store free ${(free / GIB).toFixed(0)} GiB below ${(required / GIB).toFixed(0)} GiB required for max-in-flight ${persona.flags.maxInFlight}; lower --max-in-flight before opting out of the cache`
  )
  return { persona: { ...persona, flags: { ...persona.flags, carStore: 'stream-only' } }, warnings }
}

function getSqliteVersion(): string {
  const db = new DatabaseSync(':memory:')
  try {
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    return row.v
  } finally {
    db.close()
  }
}

export async function runAnalyze(opts: AnalyzeOptions): Promise<AnalyzeReport> {
  log(`network: ${opts.network}`)
  log(`gateway: ${opts.gateway}`)

  const runtime = {
    node: process.version,
    os: osRelease(),
    platform: osPlatform(),
    sqliteVersion: getSqliteVersion(),
  }

  // Disk readings for db and car-store partitions.
  const diskReadings: DiskReading[] = []
  if (opts.dbPath != null) {
    const r = await diskFree(opts.dbPath)
    if (r != null) diskReadings.push(r)
  }
  let carStoreFreeBytes: number | null = null
  if (opts.carStorePath != null) {
    const r = await diskFree(opts.carStorePath)
    if (r != null) {
      diskReadings.push(r)
      carStoreFreeBytes = r.freeBytes
    }
  } else if (diskReadings.length > 0) {
    // Use the db partition as the car-store proxy when no path is given.
    carStoreFreeBytes = diskReadings[0].freeBytes
  }

  // Stride-sample the CID list.
  let sample: string[] = []
  let total = 0
  if (opts.cidsFile != null) {
    log(`sampling CID list (sample=${opts.all ? 'all' : opts.sample})`)
    const r = await strideSampleCidFile(opts.cidsFile, opts.sample, opts.all)
    sample = r.sample
    total = r.total
    log(`CID list: ${total} total, sampled ${sample.length}`)
  }

  // Probe the source gateway against the sample.
  let sourceGateway: AnalyzeReport['sourceGateway'] = null
  let probeFailureRate = 0
  let estimatedTotalSizeBytes: number | null = null
  if (sample.length > 0) {
    log(`probing ${sample.length} CID(s) against ${opts.gateway} with concurrency ${opts.probeConcurrency}`)
    const probeResults = await pool(sample, opts.probeConcurrency, (cid) => probeOne(opts.gateway, cid))
    const probes: ProbeSampleResult[] = probeResults.map((r) =>
      r.ok
        ? r.value
        : { cid: 'unknown', ok: false, deterministic: false, bytes: null, latencyMs: null, error: r.error.message }
    )
    const okCount = probes.filter((p) => p.ok).length
    const detCount = probes.filter((p) => p.deterministic).length
    const latencies = probes.map((p) => p.latencyMs).filter((n): n is number => n != null)
    probeFailureRate = probes.length === 0 ? 0 : (probes.length - okCount) / probes.length
    sourceGateway = {
      gateway: opts.gateway,
      probes,
      successRate: probes.length === 0 ? 0 : okCount / probes.length,
      deterministicRate: probes.length === 0 ? 0 : detCount / probes.length,
      latencyP50Ms: percentile(latencies, 0.5),
    }
    // Extrapolate total size from probe bytes (CAR size per CID).
    const okBytes = probes.filter((p) => p.bytes != null).map((p) => p.bytes as number)
    if (okBytes.length > 0 && total > 0) {
      const avg = okBytes.reduce((a, b) => a + b, 0) / okBytes.length
      estimatedTotalSizeBytes = Math.round(avg * total)
    }
  }

  // Optional bandwidth probe.
  let bandwidth: BandwidthReading | null = null
  if (opts.bwTarget != null) {
    log(`measuring upload throughput to ${opts.bwTarget}`)
    try {
      bandwidth = await measureBandwidth(opts.bwTarget)
    } catch (err) {
      log(`bandwidth probe failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Existing DB state, if present.
  let existingDb: AnalyzeReport['existingDb'] = null
  if (opts.dbPath != null) {
    try {
      statSync(opts.dbPath)
      const db = new MigrationDB(opts.dbPath)
      try {
        existingDb = {
          path: opts.dbPath,
          pieces: db.counts(),
          aggregatesByStatus: db.aggregatesByStatus(),
        }
      } finally {
        db.close()
      }
    } catch {
      // db file does not exist yet; nothing to read.
    }
  }

  const persona0 = matchPersona({
    totalAssets: total,
    estimatedTotalBytes: estimatedTotalSizeBytes,
    carStoreFreeBytes,
    bandwidthMbit: bandwidth?.mbitPerSecond ?? null,
  })
  const { persona, warnings: cacheWarnings } = applyCacheHeuristic(persona0, {
    carStoreFreeBytes,
    probeFailureRate,
  })

  const warnings: string[] = [...cacheWarnings]
  if (sourceGateway != null) {
    if (sourceGateway.deterministicRate < 1 && sourceGateway.probes.length > 0) {
      warnings.push(
        `source gateway returned non-deterministic CARs on ${sourceGateway.probes.length - Math.round(sourceGateway.deterministicRate * sourceGateway.probes.length)}/${sourceGateway.probes.length} probes`
      )
    }
    if (sourceGateway.latencyP50Ms != null && sourceGateway.latencyP50Ms > 500) {
      warnings.push(`source-gateway p50 latency ${sourceGateway.latencyP50Ms} ms above 500 ms`)
    }
  }
  if (opts.bwTarget == null) {
    warnings.push('upload throughput not measured (pass --bw-target URL to enable)')
  }

  return {
    network: opts.network,
    runtime,
    input: {
      cidsFile: opts.cidsFile ?? null,
      sampledCount: sample.length,
      totalCount: total,
      estimatedTotalSizeBytes,
    },
    disk: diskReadings,
    sourceGateway,
    bandwidth,
    existingDb,
    persona,
    warnings,
  }
}

function formatBytes(n: number | null): string {
  if (n == null) return 'unknown'
  if (n >= GIB) return `${(n / GIB).toFixed(1)} GiB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  return `${n} B`
}

/** Render the report in the layout sketched in the issue body. */
export function formatAnalyzeText(report: AnalyzeReport): string {
  const lines: string[] = []
  lines.push(`Persona match: ${report.persona.name}`)
  if (report.input.cidsFile != null) {
    const size = report.input.estimatedTotalSizeBytes
    const extra = size == null ? '' : `, extrapolated ${formatBytes(size)}`
    lines.push(`  Assets: ${report.input.totalCount.toLocaleString()} (sampled ${report.input.sampledCount}${extra})`)
  }
  for (const d of report.disk) {
    lines.push(`  Disk free: ${formatBytes(d.freeBytes)} on ${d.path}`)
  }
  if (report.bandwidth != null) {
    lines.push(`  Upload bw: ${report.bandwidth.mbitPerSecond.toFixed(0)} Mbit/s sustained`)
  }
  if (report.sourceGateway != null) {
    const sg = report.sourceGateway
    const det = `${Math.round(sg.deterministicRate * sg.probes.length)}/${sg.probes.length}`
    const p50 = sg.latencyP50Ms == null ? '' : `${sg.latencyP50Ms}ms p50, `
    lines.push(`  Source gateway: ${sg.gateway} — ${p50}deterministic ${det}`)
  }
  lines.push(`  Network: ${report.network}`)
  lines.push(
    `  Runtime: node ${report.runtime.node}, sqlite ${report.runtime.sqliteVersion}, ${report.runtime.platform} ${report.runtime.os}`
  )
  if (report.existingDb != null) {
    const p = report.existingDb.pieces
    lines.push(`  Existing DB: ${p.done} done, ${p.pending} pending, ${p.failed} failed (${report.existingDb.path})`)
  }
  lines.push('')
  lines.push('Recommended flags:')
  const f = report.persona.flags
  lines.push(`  --max-in-flight ${f.maxInFlight}`)
  lines.push(`  --piece-size ${f.pieceSize}`)
  lines.push(`  --pull-batch ${f.pullBatch}`)
  lines.push(`  --ingress ${f.ingress}`)
  if (f.carStore === 'stream-only') {
    lines.push(`  (no --car-store; cached sub-piece path opted out)`)
  } else {
    const note = f.carStore === 'required' ? ' # required: source-gateway failure rate too high to skip' : ''
    lines.push(`  --car-store <dir>${note}   # planned`)
  }
  lines.push('')
  if (report.persona.reasons.length > 0) {
    lines.push('Persona reasoning:')
    for (const r of report.persona.reasons) lines.push(`  - ${r}`)
    lines.push('')
  }
  if (report.warnings.length > 0) {
    lines.push('Warnings:')
    for (const w of report.warnings) lines.push(`  - ${w}`)
  }
  return lines.join('\n')
}
