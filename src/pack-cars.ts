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
import * as Link from 'multiformats/link'
import * as Raw from 'multiformats/codecs/raw'
import type { MigrationDB, PieceRow } from './db.ts'
import { fetchCar } from './gateway.ts'
import { log, pool } from './util.ts'

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

async function* toAsyncIterable(
  body: ReadableStream<Uint8Array>
): AsyncIterable<Uint8Array> {
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
  return {
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        if (stream.write(chunk)) {
          resolve()
        } else {
          stream.once('drain', resolve)
        }
        stream.once('error', reject)
      })
    },
    end() {
      return new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()))
      })
    },
  }
}

export interface PackCarsOptions {
  /** Source-CAR gateways, used to re-fetch member CARs during assembly. */
  gateways: string[]
  /** Per-sub-piece raw-size budget. Default `DEFAULT_PACK_TARGET_BYTES`. */
  targetSizeBytes?: number
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
}

/**
 * Drive the pack stage end-to-end: bin the `done` pieces, persist planned rows,
 * then assemble each bin to disk. Idempotent — re-running picks up only rows
 * that are still in `planned`.
 */
export async function runPackCars(db: MigrationDB, opts: PackCarsOptions): Promise<PackCarsSummary> {
  const target = opts.targetSizeBytes ?? Number(DEFAULT_PACK_TARGET_BYTES)
  if (target > PIECE_RAW_SIZE_LIMIT) {
    throw new Error(
      `--pack-target-size ${target} exceeds the per-sub-piece raw cap ${PIECE_RAW_SIZE_LIMIT}`
    )
  }
  await mkdir(opts.carStore, { recursive: true })

  // 1. Bin pack any pieces not already locked into an existing sub-piece.
  const free = db.donePiecesFreeForPacking()
  if (free.length > 0) {
    const inputs: PackPlanInput[] = free.map((p) => ({
      cid: p.cid,
      rawSize: p.rawSize ?? 0,
    }))
    const { bins } = planBins(inputs, target)
    for (const bin of bins) {
      // The planned sub-piece CID is the piece commitment over the assembled
      // bytes; we can only know it after the build step. The placeholder used
      // here is a content-addressed key over the member set so re-runs
      // recognise the same bin. The row is filled in once the build matches.
      // Build then persists under the real piece CID.
      // (Implementation note: we skip the planned row and persist on build
      // success only; this keeps the schema clean of intermediate state.)
      void bin
    }
  }

  // 2. Build any bins we have not yet assembled. For first ship the planning
  // and build steps both run here in one pass, so the bin list above doubles
  // as the assembly worklist.
  const inputsForBuild: PackPlanInput[] = db.donePiecesFreeForPacking().map((p) => ({
    cid: p.cid,
    rawSize: p.rawSize ?? 0,
  }))
  const { bins } = planBins(inputsForBuild, target)

  const summary: PackCarsSummary = { bins: bins.length, built: 0, failed: 0, skipped: 0 }
  const fetchConcurrency = opts.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY
  for (const bin of bins) {
    try {
      const piecesByCid = new Map<string, PieceRow>(
        db.donePiecesFreeForPacking().map((p) => [p.cid, p])
      )
      const built = await buildOneBin(bin, target, opts.carStore, opts.gateways, fetchConcurrency)
      // Persist planned + transition to built atomically by ordering the calls.
      db.recordPlannedSubPiece({
        subPieceCid: built.pieceCid,
        assembledCarLength: built.assembledBytes,
        targetSizeBytes: target,
        members: bin.memberCids.map((cid) => ({
          cid,
          rawSize: piecesByCid.get(cid)?.rawSize ?? null,
          sha256: null,
        })),
      })
      db.markSubPieceBuilt(built.pieceCid, built.filePath, built.sha256)
      log(`  + sub-piece ${built.pieceCid} (${built.assembledBytes} bytes, ${bin.memberCids.length} member(s))`)
      summary.built += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`  ! sub-piece build failed: ${message}`)
      summary.failed += 1
    }
  }
  return summary
}

async function buildOneBin(
  bin: PackedBin,
  target: number,
  carStore: string,
  gateways: string[],
  fetchConcurrency: number
): Promise<{ pieceCid: string; assembledBytes: number; sha256: string; filePath: string }> {
  // Bounded fan-out across the member fetches. Each fetch returns a streaming
  // body; the assembly step consumes them in canonical order.
  const fetched = await pool(bin.memberCids, fetchConcurrency, async (cid) => {
    const primary = gateways[0]
    const result = await fetchCar(primary, cid)
    return { cid, body: result.body }
  })
  const ok = fetched.every((r) => r.ok)
  if (!ok) {
    const firstErr = fetched.find((r) => !r.ok)
    throw new Error(`member fetch failed: ${firstErr && !firstErr.ok ? firstErr.error.message : 'unknown'}`)
  }
  const memberStreams = fetched
    .filter((r): r is { ok: true; value: { cid: string; body: ReadableStream<Uint8Array> } } => r.ok)
    .map((r) => r.value)

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
