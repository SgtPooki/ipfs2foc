/**
 * Pack multiple source CIDs into one multi-root CAR sub-piece.
 *
 * The single-piece path packs one source CID into one PDP sub-piece, which caps
 * the per-aggregate pull-batch event budget. The multi-asset path groups M
 * source CIDs into one synthetic multi-root CAR and registers that CAR as a
 * single sub-piece. The aggregate's piece commitment is unchanged; the number
 * of sub-pieces — and the number of pull batches — drops by ~M.
 *
 * Pack stage:
 *   1. Sort source pieces by parsed CID bytes (CIDv0 and CIDv1 of the same DAG
 *      collapse). The sort order pins the multi-root CAR's bytes.
 *   2. Largest-first bin pack under `--pack-target-size` (raw bytes, not padded).
 *      A piece whose own raw size exceeds the target falls back to the
 *      single-piece path.
 *   3. Inside each aggregate, reject if a member CID appears in two bins —
 *      Curio's indexer collapses duplicate `(piece_cid, payload_multihash)`
 *      rows, so an aggregate-level collision would silently lose one copy.
 *
 * Build stage (one bin at a time):
 *   - Re-fetch each member CAR in canonical order.
 *   - Walk it via `@ipld/car`'s `CarBlockIterator`. The iterator transparently
 *     unwraps CAR v2 into v1; rejecting any zero-length section catches the
 *     truncation hazard in Curio's indexer
 *     (`ZeroLengthSectionAsEOF(true)` in `task_indexing.go:454`).
 *   - Re-emit through `CarWriter` (single multi-root header + deterministic
 *     `varint(len) || cid || data` framing).
 *   - Tee bytes into the piece hasher and a sha256 digest, and write through
 *     to a file under `--car-store`. The redirect server later serves that
 *     file verbatim with `Content-Length` set.
 *   - Atomically transition the sub-piece row from `planned` to `built` once
 *     the assembled commitment matches and the file is on disk.
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { CarBlockIterator, CarWriter } from '@ipld/car'
import * as Hasher from '@web3-storage/data-segment/multihash'
import { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import * as Link from 'multiformats/link'
import type { MigrationDB, PieceRow } from './db.ts'
import { fetchCar } from './gateway.ts'
import { appendAggregatesFromFreeSubPieces } from './migrate.ts'
import { log } from './util.ts'

/** Default target raw size for one assembled sub-piece. Stays under the 1_069_547_520-byte raw cap. */
export const DEFAULT_PACK_TARGET_BYTES = 512n * 1024n * 1024n

/** Bounded fan-out for cross-member re-fetches per assembly. */
const DEFAULT_FETCH_CONCURRENCY = 4

/** Maximum CAR raw size accepted by Curio's PDP pull (`PieceSizeLimit`, see Q4). */
export const PIECE_RAW_SIZE_LIMIT = 1_069_547_520

export interface PackPlanInput {
  /** Source CID. */
  cid: string
  /** Raw CAR size in bytes — used as the bin-packing weight. */
  rawSize: number
}

export interface PackedBin {
  /** Member CIDs in the canonical (parsed-bytes ascending) order. */
  memberCids: string[]
  /** Sum of member raw sizes. Used as the planning weight, not the final CAR length. */
  totalRawSize: number
}

/**
 * Compare two CID strings by their parsed binary form. CIDv0 (`Qm...`) and
 * CIDv1 (`baf...`) of the same DAG produce wildly different lexicographic
 * orderings on the string form; comparing parsed bytes collapses that alias so
 * a single canonical ordering exists regardless of which form the source CID
 * was registered as.
 */
export function compareCidBytes(a: string, b: string): number {
  const ba = CID.parse(a).bytes
  const bb = CID.parse(b).bytes
  const len = Math.min(ba.length, bb.length)
  for (let i = 0; i < len; i += 1) {
    if (ba[i] !== bb[i]) {
      return ba[i] - bb[i]
    }
  }
  return ba.length - bb.length
}

/**
 * Largest-first bin pack under `targetSizeBytes` (raw bytes). Pieces above the
 * target on their own fall back to the single-piece path — they are returned in
 * the `oversizedForPacking` list so the caller can register them as one-CID
 * sub-pieces. Within each bin the members are emitted in canonical sort order.
 */
export function planBins(
  pieces: PackPlanInput[],
  targetSizeBytes: number
): { bins: PackedBin[]; oversizedForPacking: PackPlanInput[] } {
  if (targetSizeBytes <= 0) {
    throw new Error(`pack target size must be > 0 (got ${targetSizeBytes})`)
  }
  // Reject the aggregate-level CID collision up-front: the same source CID
  // appearing twice in the plan would collapse to one indexed entry on the
  // provider side. Higher-level callers should de-duplicate the input.
  const seen = new Set<string>()
  for (const p of pieces) {
    if (seen.has(p.cid)) {
      throw new Error(`duplicate source CID in pack plan: ${p.cid}`)
    }
    seen.add(p.cid)
  }

  const oversized: PackPlanInput[] = []
  const fits = pieces.filter((p) => {
    if (p.rawSize > targetSizeBytes) {
      oversized.push(p)
      return false
    }
    return true
  })
  // Largest first: keeps the bin count down and matches the heuristic
  // `pieceAggregateCommP` uses one layer up.
  const sorted = [...fits].sort((a, b) => b.rawSize - a.rawSize)
  const bins: Array<{ pieces: PackPlanInput[]; used: number }> = []
  for (const piece of sorted) {
    let placed = false
    for (const bin of bins) {
      if (bin.used + piece.rawSize <= targetSizeBytes) {
        bin.pieces.push(piece)
        bin.used += piece.rawSize
        placed = true
        break
      }
    }
    if (!placed) {
      bins.push({ pieces: [piece], used: piece.rawSize })
    }
  }
  return {
    bins: bins.map((b) => ({
      memberCids: b.pieces.map((p) => p.cid).sort(compareCidBytes),
      totalRawSize: b.used,
    })),
    oversizedForPacking: oversized,
  }
}

/**
 * Build a multi-root CAR from a list of member CARs.
 *
 * The result is fully streamed: the function yields `Uint8Array` chunks as
 * blocks become available, computes the assembled PieceCID v2, the assembled
 * sha256, and the total byte length, and verifies every member CAR's bytes by
 * walking the `CarBlockIterator`. A zero-length section in any member causes
 * a hard rejection — the provider's indexer would silently truncate the rest
 * of the block stream (`ZeroLengthSectionAsEOF(true)`).
 */
export async function assembleMultiRootCar(
  memberStreams: Array<{ cid: string; body: ReadableStream<Uint8Array> }>,
  sink: WritableStreamWithLength
): Promise<{ pieceCid: string; assembledBytes: number; sha256: string; roots: string[] }> {
  // Walk each member CAR first to surface its roots and validate the block
  // stream (rejecting zero-length sections). Then re-emit through CarWriter so
  // the output is one deterministic multi-root CAR.
  const roots: CID[] = []
  const blockRuns: Array<{ cid: CID; bytes: Uint8Array }[]> = []
  for (const member of memberStreams) {
    const expected = CID.parse(member.cid)
    const reader = await CarBlockIterator.fromIterable(toAsyncIterable(member.body))
    const blocks: Array<{ cid: CID; bytes: Uint8Array }> = []
    for await (const block of reader) {
      if (block.bytes.length === 0) {
        // Curio's indexer treats a zero-length block section as EOF and stops
        // walking the rest of the CAR; the missing blocks never become
        // retrievable. Refuse to assemble such a member.
        throw new Error(
          `member ${member.cid}: zero-length block section at cid ${block.cid.toString()} — indexer would truncate`
        )
      }
      blocks.push({ cid: block.cid, bytes: block.bytes })
    }
    const memberRoots = await reader.getRoots()
    if (!memberRoots.some((r) => r.equals(expected) || r.toString() === member.cid)) {
      throw new Error(
        `member ${member.cid}: CAR root mismatch — declares [${memberRoots.map((r) => r.toString()).join(', ')}]`
      )
    }
    roots.push(expected)
    blockRuns.push(blocks)
  }

  // Cast: @ipld/car pins multiformats@14 while this project uses 13; the CID
  // wire shape is identical but the structural types diverge. The bytes are
  // what matter to the writer.
  const { writer, out } = CarWriter.create(roots as never)
  const hasher = Hasher.create()
  const sha = createHash('sha256')
  let assembledBytes = 0

  const drained = (async () => {
    for await (const chunk of out as unknown as AsyncIterable<Uint8Array>) {
      hasher.write(chunk)
      sha.update(chunk)
      assembledBytes += chunk.length
      await sink.write(chunk)
    }
  })()

  for (const run of blockRuns) {
    for (const block of run) {
      await writer.put(block as never)
    }
  }
  await writer.close()
  await drained
  await sink.end()

  const digest = hasher.digest()
  const pieceCid = (Link.create(Raw.code, digest) as CID).toString()
  return {
    pieceCid,
    assembledBytes,
    sha256: sha.digest('hex'),
    roots: roots.map((r) => r.toString()),
  }
}

/**
 * Sink shape that `assembleMultiRootCar` writes through. The file-store
 * implementation writes through to disk; tests can pass an in-memory stand-in
 * to verify the assembly without touching the filesystem.
 */
export interface WritableStreamWithLength {
  write(chunk: Uint8Array): Promise<void>
  end(): Promise<void>
}

async function* toAsyncIterable(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    yield chunk
  }
}

/**
 * Stream-write sink backed by a file under `--car-store`. The directory is
 * created on demand; the file is fsynced via the regular WriteStream `end`.
 */
export function createCarStoreSink(filePath: string): WritableStreamWithLength {
  const stream = createWriteStream(filePath)
  let firstError: Error | null = null
  let cleanupDone = false
  const unlinkPartial = async () => {
    if (cleanupDone) return
    cleanupDone = true
    // The file may not exist (createWriteStream's open failed) or may be
    // partially written. unlink errors are swallowed: the failure we surface
    // is the write/open error, not the cleanup error.
    await unlink(filePath).catch(() => undefined)
  }
  stream.on('error', (err) => {
    if (firstError == null) firstError = err
    void unlinkPartial()
  })
  return {
    write(chunk) {
      if (firstError != null) return Promise.reject(firstError)
      return new Promise<void>((resolve, reject) => {
        if (firstError != null) return reject(firstError)
        const onError = (err: Error) => reject(err)
        stream.once('error', onError)
        const cleanup = () => stream.off('error', onError)
        const ok = stream.write(chunk, (err) => {
          cleanup()
          if (err) reject(err)
          else if (ok) resolve()
        })
        if (!ok)
          stream.once('drain', () => {
            cleanup()
            resolve()
          })
      })
    },
    async end() {
      if (firstError != null) {
        await unlinkPartial()
        throw firstError
      }
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()))
      }).catch(async (err) => {
        await unlinkPartial()
        throw err
      })
    },
  }
}

export interface PackCarsOptions {
  /** Source-CAR gateways, used to re-fetch member CARs during assembly. */
  gateways: string[]
  /** Per-sub-piece raw-size budget. Default `DEFAULT_PACK_TARGET_BYTES`. */
  targetSizeBytes?: number
  /** Aggregate raw-size budget passed to `repackAfterPackCars`. Must match `--piece-size` plan used. */
  aggregateSizeBytes?: bigint
  /** Directory under which assembled CAR files are persisted. Required for first ship. */
  carStore: string
  /** Bounded fan-out per assembly. Default 4. */
  fetchConcurrency?: number
}

export interface PackCarsSummary {
  bins: number
  built: number
  failed: number
  skipped: number
  /**
   * Source CIDs whose bin failed to assemble. They stay `done` and re-enter the
   * free pool on the next run (a transient gateway flap recovers); a CID that
   * keeps reappearing here across runs has a permanent assembly problem the
   * operator must investigate. Surfaced per-CID because `failed` counts bins,
   * not CIDs.
   */
  failedMemberCids: string[]
}

/**
 * Drive the pack stage end-to-end: bin the `done` pieces, persist planned rows,
 * then assemble each bin to disk. Idempotent — re-running picks up only rows
 * that are still in `planned`.
 */
/** The bin assembler `runPackCars` drives; injectable so the pack loop's
 *  success/failure accounting is testable without re-fetching member CARs. */
export type BinBuilder = (
  bin: PackedBin,
  target: number,
  carStore: string,
  gateways: string[],
  fetchConcurrency: number
) => Promise<{ pieceCid: string; assembledBytes: number; sha256: string; filePath: string }>

export async function runPackCars(
  db: MigrationDB,
  opts: PackCarsOptions,
  buildBin: BinBuilder = buildOneBin
): Promise<PackCarsSummary> {
  const target = opts.targetSizeBytes ?? Number(DEFAULT_PACK_TARGET_BYTES)
  if (target > PIECE_RAW_SIZE_LIMIT) {
    throw new Error(`--pack-target-size ${target} exceeds the per-sub-piece raw cap ${PIECE_RAW_SIZE_LIMIT}`)
  }
  await mkdir(opts.carStore, { recursive: true })

  // Snapshot the free pieces once. planBins partitions them into disjoint bins,
  // so the member-size map built here stays valid for every bin even as each
  // recordBuiltSubPiece locks its own members — a later bin never references a
  // CID an earlier bin already claimed.
  const free = db.donePiecesFreeForPacking()
  const piecesByCid = new Map<string, PieceRow>(free.map((p) => [p.cid, p]))
  const inputsForBuild: PackPlanInput[] = free.map((p) => ({
    cid: p.cid,
    rawSize: p.rawSize ?? 0,
  }))
  const { bins, oversizedForPacking } = planBins(inputsForBuild, target)

  const summary: PackCarsSummary = { bins: bins.length, built: 0, failed: 0, skipped: 0, failedMemberCids: [] }
  const fetchConcurrency = opts.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY
  for (const bin of bins) {
    try {
      const built = await buildBin(bin, target, opts.carStore, opts.gateways, fetchConcurrency)
      // One transaction inserts the sub_piece row in `built` status alongside
      // its members. A crash anywhere before this returns leaves no partial DB
      // state — the CAR file on disk is the only stranded artifact, and the
      // next pack-cars run can rebuild and replace it.
      db.recordBuiltSubPiece({
        subPieceCid: built.pieceCid,
        assembledCarLength: built.assembledBytes,
        targetSizeBytes: target,
        carPath: built.filePath,
        assembledSha256: built.sha256,
        members: bin.memberCids.map((cid) => ({
          cid,
          rawSize: piecesByCid.get(cid)?.rawSize ?? null,
          sha256: null,
        })),
      })
      log(`  + sub-piece ${built.pieceCid} (${built.assembledBytes} bytes, ${bin.memberCids.length} member(s))`)
      summary.built += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Surface which source CIDs failed to pack — `failed` alone counts bins,
      // not CIDs, so without this the operator can't tell what didn't migrate.
      // No DB write: the members stay `done` and a transient failure recovers on
      // the next run; a CID that keeps failing here is a permanent problem to
      // investigate, not a silent drop.
      summary.failedMemberCids.push(...bin.memberCids)
      log(`  ! sub-piece build failed (${bin.memberCids.length} member(s): ${bin.memberCids.join(', ')}): ${message}`)
      summary.failed += 1
    }
  }

  // Pieces too large to share a bin still need to migrate. planBins returns
  // them in `oversizedForPacking`; register each as a single-CID passthrough
  // sub-piece served from its gateway URL — the same shape plan's default path
  // produces. Dropping them here (the prior bug) left them stranded as `done`
  // with no sub-piece and no aggregate, silently absent from the migration.
  let passthroughAdded = 0
  const noGatewayUrl: string[] = []
  for (const p of oversizedForPacking) {
    const row = piecesByCid.get(p.cid)
    if (row?.pieceCid == null || row.rawSize == null || row.url == null || row.url === '') {
      // No gateway URL (IPFS-fallback only): cannot be served by the HTTP pull
      // and cannot be re-fetched for assembly either. Surface, do not drop.
      noGatewayUrl.push(p.cid)
      continue
    }
    db.recordPassthroughSubPiece({
      subPieceCid: row.pieceCid,
      sourceCid: row.cid,
      url: row.url,
      rawSize: row.rawSize,
      memberSha256: null,
    })
    passthroughAdded += 1
    log(`  + passthrough sub-piece ${row.pieceCid} (${row.rawSize} bytes, oversized for packing)`)
  }
  if (noGatewayUrl.length > 0) {
    log(
      `! ${noGatewayUrl.length} oversized piece(s) have no gateway URL (IPFS-fallback only) and ` +
        `cannot be served by the provider pull; not migrated: ${noGatewayUrl.join(', ')}`
    )
  }

  // Repack planned aggregates so their members reference the freshly built
  // sub-pieces. Without this, `pdp-submit` still sees the per-source-CID
  // composition `plan` wrote and asks the SP to pull individual files (most
  // of which are below the provider's minimum piece size). Frozen aggregates
  // (submitted/parked/committed) are left untouched.
  if (summary.built > 0 || passthroughAdded > 0) {
    // Append new aggregates over the freshly built multi-asset sub-pieces.
    // No DELETE of existing aggregates — `plan` already added passthrough
    // aggregates over the source pieces, and those stay as the alternative
    // path for any operator who prefers single-asset commits.
    const existing = db.aggregates().find((a) => a.status === 'planned')
    const aggregateSizeBytes =
      opts.aggregateSizeBytes ?? (existing == null ? 32n * 1024n * 1024n * 1024n : BigInt(existing.pieceSizeBytes))
    appendAggregatesFromFreeSubPieces(db, aggregateSizeBytes)
  }

  return summary
}

/**
 * Fetch a member CAR, trying each gateway in order until one yields a body.
 * Mirrors `fetchAndComputePiece`'s gateway iteration — a single gateway flap
 * must not fail the whole bin when fallbacks are configured.
 */
async function fetchCarFromAnyGateway(gateways: string[], cid: string): Promise<Awaited<ReturnType<typeof fetchCar>>> {
  const errors: string[] = []
  for (const gateway of gateways) {
    try {
      return await fetchCar(gateway, cid)
    } catch (err) {
      errors.push(`${gateway}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`all gateways failed for ${cid}: ${errors.join('; ')}`)
}

async function buildOneBin(
  bin: PackedBin,
  target: number,
  carStore: string,
  gateways: string[],
  fetchConcurrency: number
): Promise<{ pieceCid: string; assembledBytes: number; sha256: string; filePath: string }> {
  // Fetch lazily, one member at a time. Pre-fetching all member streams in
  // parallel keeps the later ones idle while the first is consumed; the
  // gateway closes those idle response bodies after its inactivity timeout
  // and the consumer sees `Unexpected end of data`. Streaming each member in
  // turn keeps every response under active read.
  void fetchConcurrency
  const memberStreams: Array<{ cid: string; body: ReadableStream<Uint8Array> }> = bin.memberCids.map((cid) => ({
    cid,
    get body(): ReadableStream<Uint8Array> {
      throw new Error(`internal: member body must be fetched lazily for ${cid}`)
    },
  }))
  // Override the lazy body with a fetch invoked at consume time. The
  // assembler iterates `memberStreams` sequentially, so this materialises
  // each body just before its bytes are read.
  for (const m of memberStreams) {
    Object.defineProperty(m, 'body', {
      configurable: true,
      get() {
        // Replace the getter with a resolved stream on first access.
        const promise = fetchCarFromAnyGateway(gateways, m.cid).then((r) => r.body)
        const lazy = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              const body = await promise
              const reader = (
                body as unknown as { getReader: () => ReadableStreamDefaultReader<Uint8Array> }
              ).getReader()
              while (true) {
                const { value, done } = await reader.read()
                if (done) break
                controller.enqueue(value)
              }
              controller.close()
            } catch (err) {
              controller.error(err)
            }
          },
        })
        Object.defineProperty(m, 'body', { value: lazy, configurable: false })
        return lazy
      },
    })
  }

  void target

  const tmpName = `pack-${process.pid}-${Date.now()}.car`
  const tmpPath = path.join(carStore, tmpName)
  const sink = createCarStoreSink(tmpPath)
  try {
    const result = await assembleMultiRootCar(memberStreams, sink)
    const finalPath = path.join(carStore, `${result.pieceCid}.car`)
    // Rename through the same directory so it's an atomic move on local FS.
    const { rename } = await import('node:fs/promises')
    await rename(tmpPath, finalPath)
    return {
      pieceCid: result.pieceCid,
      assembledBytes: result.assembledBytes,
      sha256: result.sha256,
      filePath: finalPath,
    }
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined)
    throw err
  }
}
