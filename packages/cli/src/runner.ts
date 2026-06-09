/**
 * Pausable, concurrent commP runner for the daemon.
 *
 * Drives the same per-CID work as the batch `plan` command, but as a long-lived
 * loop that can be paused/resumed and accept new CIDs or gateways at runtime.
 * State is the DB (resumable); this just schedules workers against it. When the
 * pending queue drains, it repacks aggregates so the dashboard always reflects a
 * current plan.
 */

import type { MigrationDB } from './db.ts'
import { appendAggregatesFromFreeSubPieces, wrapDonePiecesAsPassthroughSubPieces } from './migrate.ts'
import { categoryOf, fetchAndComputePiece, recordPieceOutcome } from './piece.ts'
import { log } from './util.ts'

export type RunState = 'idle' | 'running' | 'paused'

export interface RunnerOptions {
  gateways: string[]
  concurrency: number
  aggregateSizeBytes: bigint
  ipfsFallback?: boolean
  fallbackTimeoutMs?: number
}

export class Runner {
  #db: MigrationDB
  #gateways: string[]
  #concurrency: number
  #aggregateSizeBytes: bigint
  #ipfsFallback: boolean
  #fallbackTimeoutMs: number | undefined
  #state: RunState = 'idle'
  #active = 0
  #lastError: string | null = null

  constructor(db: MigrationDB, opts: RunnerOptions) {
    this.#db = db
    this.#gateways = opts.gateways
    this.#concurrency = opts.concurrency
    this.#aggregateSizeBytes = opts.aggregateSizeBytes
    this.#ipfsFallback = opts.ipfsFallback === true
    this.#fallbackTimeoutMs = opts.fallbackTimeoutMs
    // Recover any work interrupted by a previous stop.
    this.#db.resetProcessing()
  }

  get state(): RunState {
    return this.#state
  }

  get gateways(): string[] {
    return [...this.#gateways]
  }

  get aggregateSizeBytes(): bigint {
    return this.#aggregateSizeBytes
  }

  get active(): number {
    return this.#active
  }

  get lastError(): string | null {
    return this.#lastError
  }

  setGateways(gateways: string[]): void {
    if (gateways.length > 0) {
      this.#gateways = gateways
    }
  }

  setAggregateSize(bytes: bigint): void {
    this.#aggregateSizeBytes = bytes
  }

  addCids(cids: string[]): number {
    this.#db.addCids(cids)
    this.#kick()
    return cids.length
  }

  retryFailed(): void {
    this.#db.retryFailed()
    this.#kick()
  }

  start(): void {
    if (this.#state === 'running') {
      return
    }
    this.#state = 'running'
    this.#kick()
  }

  pause(): void {
    if (this.#state === 'running') {
      this.#state = 'paused'
    }
  }

  resume(): void {
    if (this.#state === 'paused') {
      this.#state = 'running'
      this.#kick()
    }
  }

  /** Start up to `concurrency` workers while there is work to claim. */
  #kick(): void {
    if (this.#state !== 'running') {
      return
    }
    while (this.#active < this.#concurrency) {
      const cid = this.#db.claimNextPending()
      if (cid == null) {
        break
      }
      this.#active++
      void this.#process(cid)
    }
    if (this.#active === 0) {
      // Nothing in flight and nothing claimable -> queue is drained.
      this.#repack()
      this.#state = 'idle'
    }
  }

  async #process(cid: string): Promise<void> {
    try {
      const piece = await fetchAndComputePiece(cid, this.#gateways, {
        ipfsFallback: this.#ipfsFallback,
        fallbackTimeoutMs: this.#fallbackTimeoutMs,
      })
      recordPieceOutcome(this.#db, cid, piece)
      log(`  + ${cid} -> ${piece.pieceCid}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.#db.recordPieceFailure(cid, message, categoryOf(err))
      this.#lastError = `${cid}: ${message.split('\n')[0]}`
    } finally {
      this.#active--
      // Claim the next item (or repack + idle if drained).
      this.#kick()
    }
  }

  #repack(): void {
    wrapDonePiecesAsPassthroughSubPieces(this.#db)
    appendAggregatesFromFreeSubPieces(this.#db, this.#aggregateSizeBytes)
  }
}
