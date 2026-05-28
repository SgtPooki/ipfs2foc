/**
 * State store, backed by Node's built-in node:sqlite (no dependency).
 *
 * The database is the single source of truth for a migration run: each CID's
 * piece commitment, the aggregates it was packed into, and per-step status. A
 * run resumes from here after any interruption.
 */

import { DatabaseSync } from 'node:sqlite'

export type PieceStatus = 'pending' | 'processing' | 'done' | 'failed' | 'oversized'

/**
 * Failure taxonomy used by `status --json` and the dashboard. Set alongside
 * `pieces.error` so operators can triage by category rather than parsing
 * free-form error strings.
 */
export type FailureCategory =
  | 'source_gateway_429'
  | 'source_gateway_5xx'
  | 'source_gateway_timeout'
  | 'car_root_mismatch'
  | 'commp_mismatch'
  | 'oversized'
  | 'pull_cap_exceeded'
  | 'byte_unstable'
  | 'other'

/**
 * Last-resort classifier for free-form error strings that did not come from a
 * `GatewayError` / `PieceComputeError` (so a category was not set at the
 * throw site). Prefer typed errors with explicit categories.
 */
export function classifyFailure(message: string): FailureCategory {
  const m = message.toLowerCase()
  if (m.includes('429') || m.includes('too many requests')) return 'source_gateway_429'
  if (/\b5\d\d\b/.test(m) || m.includes('bad gateway') || m.includes('service unavailable')) return 'source_gateway_5xx'
  if (m.includes('timeout') || m.includes('timed out') || m.includes('etimedout')) return 'source_gateway_timeout'
  if (m.includes('car root mismatch')) return 'car_root_mismatch'
  if (m.includes('piece commitment') || m.includes('commp')) return 'commp_mismatch'
  if (m.includes('oversized') || (m.includes('exceeds') && m.includes('piece-size'))) return 'oversized'
  if (m.includes('pull') && m.includes('cap')) return 'pull_cap_exceeded'
  return 'other'
}

/**
 * Aggregate lifecycle.
 *
 *   planned    packed locally, not yet sent to a storage provider
 *   submitted  the provider has accepted the pull and is downloading sub-pieces
 *   parked     every sub-piece downloaded and verified by the provider; the
 *              gateways are not needed past this point, but nothing is on-chain yet
 *   committed  AddPieces is on-chain; the aggregate piece CID and data set are final
 *   failed     the pull was rejected, or a sub-piece could not be pulled or verified
 *
 * `inFlightUncommittedCount` reports how many aggregates sit at `submitted` or
 * `parked` without reaching `committed`. Submission uses it to keep parked data
 * moving to commitment rather than accumulating on a provider.
 */
export type AggregateStatus = 'planned' | 'submitted' | 'parked' | 'committed' | 'failed'

export interface PieceRow {
  cid: string
  pieceCid: string | null
  rawSize: number | null
  gateway: string | null
  url: string | null
  status: PieceStatus
  error: string | null
}

export interface AggregateRow {
  idx: number
  /** Aggregate root PieceCID v2 — the parent CID added on-chain for the aggregate. */
  rootPieceCid: string
  pieceSizeBytes: string
  status: AggregateStatus
  /** Synthetic per-aggregate pull marker, set when submission begins. */
  pullId: string | null
  /** On-chain PDP data set + piece the aggregate was committed to. */
  dataSetId: string | null
  pieceId: string | null
  txHash: string | null
  /** Block number of the AddPieces receipt; set when the PiecesAdded event is verified. */
  committedBlock: string | null
  memberCount: number
  /** Lifecycle timestamps; null until the corresponding transition fires. */
  submittedAt: string | null
  parkedAt: string | null
  committedAt: string | null
  /** Error string set by `markAggregateFailed`, null otherwise. */
  error: string | null
}

export class MigrationDB {
  #db: DatabaseSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#migrate()
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS pieces (
        cid              TEXT PRIMARY KEY,
        piece_cid        TEXT,
        raw_size         INTEGER,
        gateway          TEXT,
        url              TEXT,
        status           TEXT NOT NULL DEFAULT 'pending',
        error            TEXT,
        failure_category TEXT,
        updated_at       TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS aggregates (
        idx              INTEGER PRIMARY KEY,
        root_piece_cid   TEXT NOT NULL,
        piece_size_bytes TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'planned',
        pull_id          TEXT,
        data_set_id      TEXT,
        piece_id         TEXT,
        tx_hash          TEXT,
        committed_block  TEXT,
        error            TEXT,
        submitted_at     TEXT,
        parked_at        TEXT,
        committed_at     TEXT,
        created_at       TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS aggregate_members (
        aggregate_idx INTEGER NOT NULL,
        segment_index INTEGER NOT NULL,
        cid           TEXT NOT NULL,
        PRIMARY KEY (aggregate_idx, cid),
        FOREIGN KEY (cid) REFERENCES pieces(cid),
        FOREIGN KEY (aggregate_idx) REFERENCES aggregates(idx)
      );
      CREATE TABLE IF NOT EXISTS pull_batch_attempts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        aggregate_idx INTEGER NOT NULL,
        started_at    TEXT NOT NULL,
        finished_at   TEXT,
        ok_count      INTEGER NOT NULL DEFAULT 0,
        failed_count  INTEGER NOT NULL DEFAULT 0,
        piece_cids    TEXT NOT NULL,
        error         TEXT,
        FOREIGN KEY (aggregate_idx) REFERENCES aggregates(idx)
      );
    `)
  }

  /** Register CIDs for processing. Existing rows are left untouched (resumable). */
  addCids(cids: string[]): void {
    const stmt = this.#db.prepare(
      `INSERT INTO pieces (cid, status, updated_at) VALUES (?, 'pending', ?)
       ON CONFLICT(cid) DO NOTHING`
    )
    const now = new Date().toISOString()
    for (const cid of cids) {
      stmt.run(cid, now)
    }
  }

  /** CIDs not yet successfully committed to a piece commitment. */
  pendingCids(): string[] {
    const rows = this.#db
      .prepare(`SELECT cid FROM pieces WHERE status IN ('pending', 'processing', 'failed') ORDER BY cid`)
      .all()
    return rows.map((r) => (r as { cid: string }).cid)
  }

  /**
   * Atomically claim the next `pending` CID for processing. node:sqlite is
   * synchronous and Node is single-threaded, so the select+update pair runs
   * without interleaving — safe for the concurrent runner workers. Returns null
   * when nothing is pending.
   */
  claimNextPending(): string | null {
    const row = this.#db.prepare(`SELECT cid FROM pieces WHERE status='pending' ORDER BY cid LIMIT 1`).get() as
      | { cid: string }
      | undefined
    if (row == null) {
      return null
    }
    this.#db
      .prepare(`UPDATE pieces SET status='processing', updated_at=? WHERE cid=?`)
      .run(new Date().toISOString(), row.cid)
    return row.cid
  }

  /** Recover after a crash/stop: any 'processing' rows go back to 'pending'. */
  resetProcessing(): void {
    this.#db.prepare(`UPDATE pieces SET status='pending' WHERE status='processing'`).run()
  }

  /** Reset failed rows to pending so the runner retries them. */
  retryFailed(): void {
    this.#db.prepare(`UPDATE pieces SET status='pending', error=NULL WHERE status='failed'`).run()
  }

  recordPieceSuccess(cid: string, pieceCid: string, rawSize: number, gateway: string, url: string): void {
    this.#db
      .prepare(
        `UPDATE pieces SET piece_cid=?, raw_size=?, gateway=?, url=?, status='done', error=NULL, updated_at=?
         WHERE cid=?`
      )
      .run(pieceCid, rawSize, gateway, url, new Date().toISOString(), cid)
  }

  recordPieceFailure(cid: string, error: string, category: FailureCategory = 'other'): void {
    this.#db
      .prepare(`UPDATE pieces SET status='failed', error=?, failure_category=?, updated_at=? WHERE cid=?`)
      .run(error, category, new Date().toISOString(), cid)
  }

  /**
   * Mark a CID as oversized — its piece padded size exceeds the configured
   * aggregate budget, so it cannot be packed under the current `--piece-size`.
   * Distinct from `failed`: the commP pass succeeded, but the piece does not
   * fit. Resetting the status (e.g. on a larger `--piece-size`) is a
   * deliberate operator action.
   */
  markOversized(cids: string[]): void {
    if (cids.length === 0) return
    const stmt = this.#db.prepare(
      `UPDATE pieces SET status='oversized', failure_category='oversized', updated_at=? WHERE cid=?`
    )
    const now = new Date().toISOString()
    for (const cid of cids) stmt.run(now, cid)
  }

  /** Clear `oversized` status back to `done` so a re-pack with a larger budget includes them. */
  resetOversized(): void {
    this.#db
      .prepare(`UPDATE pieces SET status='done', failure_category=NULL WHERE status='oversized'`)
      .run()
  }

  /** All successfully-computed pieces, in stable order, for packing. */
  donePieces(): PieceRow[] {
    const rows = this.#db
      .prepare(`SELECT cid, piece_cid, raw_size, gateway, url, status, error FROM pieces WHERE status='done' ORDER BY cid`)
      .all()
    return rows.map(toPieceRow)
  }

  /**
   * CIDs already locked into an aggregate that has been submitted or beyond.
   * These are excluded from repacking so an in-flight aggregate is never
   * renumbered or rebuilt under a provider.
   */
  lockedMemberCids(): Set<string> {
    const rows = this.#db
      .prepare(
        `SELECT m.cid FROM aggregate_members m
         JOIN aggregates a ON a.idx = m.aggregate_idx
         WHERE a.status != 'planned'`
      )
      .all()
    return new Set(rows.map((r) => String((r as { cid: string }).cid)))
  }

  /** Drop only the `planned` aggregates so repacking leaves submitted ones intact. */
  deletePlannedAggregates(): void {
    this.#db.exec(`
      DELETE FROM aggregate_members
        WHERE aggregate_idx IN (SELECT idx FROM aggregates WHERE status='planned');
      DELETE FROM aggregates WHERE status='planned';
    `)
  }

  /** Next free aggregate index, above any existing (including submitted) aggregate. */
  nextAggregateIndex(): number {
    const row = this.#db.prepare(`SELECT COALESCE(MAX(idx), -1) AS m FROM aggregates`).get() as { m: number }
    return Number(row.m) + 1
  }

  saveAggregate(idx: number, rootPieceCid: string, pieceSizeBytes: bigint, members: string[]): void {
    this.#db
      .prepare(
        `INSERT INTO aggregates (idx, root_piece_cid, piece_size_bytes, status, created_at)
         VALUES (?, ?, ?, 'planned', ?)`
      )
      .run(idx, rootPieceCid, pieceSizeBytes.toString(), new Date().toISOString())
    const memberStmt = this.#db.prepare(
      `INSERT INTO aggregate_members (aggregate_idx, segment_index, cid) VALUES (?, ?, ?)`
    )
    members.forEach((cid, segmentIndex) => memberStmt.run(idx, segmentIndex, cid))
  }

  aggregates(): AggregateRow[] {
    const rows = this.#db
      .prepare(
        `SELECT a.idx, a.root_piece_cid, a.piece_size_bytes, a.status, a.pull_id,
                a.data_set_id, a.piece_id, a.tx_hash, a.committed_block, a.error,
                a.submitted_at, a.parked_at, a.committed_at,
                (SELECT COUNT(*) FROM aggregate_members m WHERE m.aggregate_idx = a.idx) AS member_count
         FROM aggregates a ORDER BY a.idx`
      )
      .all()
    return rows.map((r) => {
      const row = r as Record<string, unknown>
      const str = (v: unknown): string | null => (v == null ? null : String(v))
      return {
        idx: Number(row.idx),
        rootPieceCid: String(row.root_piece_cid),
        pieceSizeBytes: String(row.piece_size_bytes),
        status: row.status as AggregateStatus,
        pullId: str(row.pull_id),
        dataSetId: str(row.data_set_id),
        pieceId: str(row.piece_id),
        txHash: str(row.tx_hash),
        committedBlock: str(row.committed_block),
        memberCount: Number(row.member_count),
        submittedAt: str(row.submitted_at),
        parkedAt: str(row.parked_at),
        committedAt: str(row.committed_at),
        error: str(row.error),
      }
    })
  }

  /**
   * The gateway CAR URL for a piece, by its PieceCID v2. Used by the redirect
   * server to answer `GET /piece/{pcidv2}` with a 302 to the original gateway.
   */
  pieceUrlByPieceCid(pieceCid: string): string | null {
    const row = this.#db
      .prepare(`SELECT url FROM pieces WHERE piece_cid = ? AND status = 'done' LIMIT 1`)
      .get(pieceCid) as { url: string } | undefined
    return row?.url ?? null
  }

  /** Asset CIDs (input list) belonging to one aggregate, in segment order. */
  aggregateAssetCids(idx: number): string[] {
    const rows = this.#db
      .prepare(`SELECT cid FROM aggregate_members WHERE aggregate_idx = ? ORDER BY segment_index`)
      .all(idx)
    return rows.map((r) => String((r as { cid: string }).cid))
  }

  /** Manifest rows (`pieceCid`, `url`, `rawSize`) for one aggregate, in segment order. */
  aggregateManifest(idx: number): Array<{ pieceCid: string; url: string; rawSize: number }> {
    const rows = this.#db
      .prepare(
        `SELECT p.piece_cid AS piece_cid, p.url AS url, p.raw_size AS raw_size
         FROM aggregate_members m JOIN pieces p ON p.cid = m.cid
         WHERE m.aggregate_idx = ? ORDER BY m.segment_index`
      )
      .all(idx)
    return rows.map((r) => {
      const row = r as Record<string, unknown>
      return { pieceCid: String(row.piece_cid), url: String(row.url), rawSize: Number(row.raw_size) }
    })
  }

  /** Record that the provider accepted the pull and is downloading sub-pieces. */
  markSubmitted(idx: number, pullId: string): void {
    this.#db
      .prepare(`UPDATE aggregates SET status='submitted', pull_id=?, submitted_at=? WHERE idx=?`)
      .run(pullId, new Date().toISOString(), idx)
  }

  /** Record that every sub-piece is downloaded and verified; gateways not needed past this point. */
  markParked(idx: number): void {
    this.#db
      .prepare(`UPDATE aggregates SET status='parked', parked_at=? WHERE idx=?`)
      .run(new Date().toISOString(), idx)
  }

  /**
   * Record the on-chain AddPiece: data set, piece id, transaction hash, and the
   * receipt's block number. The block number is set only when the PiecesAdded
   * event was parsed and matched against the local aggregate root; absence
   * marks an unverified commit (see `markCommittedUnverified`).
   */
  markCommitted(idx: number, info: {
    dataSetId: string
    pieceId?: string
    txHash?: string
    committedBlock?: string
  }): void {
    this.#db
      .prepare(
        `UPDATE aggregates SET status='committed', data_set_id=?, piece_id=?, tx_hash=?,
                                committed_block=?, committed_at=? WHERE idx=?`
      )
      .run(
        info.dataSetId,
        info.pieceId ?? null,
        info.txHash ?? null,
        info.committedBlock ?? null,
        new Date().toISOString(),
        idx
      )
  }

  /**
   * Record a commit whose `addStatus` came back ok but whose receipt parse did
   * not yield a matching PiecesAdded event (RPC outage, log filter race). The
   * row is marked `committed` so the in-flight cap moves, but `committed_block`
   * stays null and `error` records the reason so `report` can re-verify against
   * the chain on a later run.
   */
  markCommittedUnverified(
    idx: number,
    info: { dataSetId: string; pieceId?: string; txHash?: string; reason: string }
  ): void {
    this.#db
      .prepare(
        `UPDATE aggregates SET status='committed', data_set_id=?, piece_id=?, tx_hash=?,
                                committed_block=NULL, error=?, committed_at=? WHERE idx=?`
      )
      .run(
        info.dataSetId,
        info.pieceId ?? null,
        info.txHash ?? null,
        info.reason,
        new Date().toISOString(),
        idx
      )
  }

  markAggregateFailed(idx: number, error?: string): void {
    this.#db
      .prepare(`UPDATE aggregates SET status='failed', error=COALESCE(?, error) WHERE idx=?`)
      .run(error ?? null, idx)
  }

  /**
   * Reset every failed aggregate back to `planned` and clear its error. The
   * runner picks them up on the next pass; pull POSTs are idempotent, and the
   * on-chain active-pieces guard skips an aggregate whose root already landed.
   */
  resetFailedAggregates(): number {
    const result = this.#db
      .prepare(`UPDATE aggregates SET status='planned', error=NULL WHERE status='failed'`)
      .run()
    return Number(result.changes)
  }

  /** Insert a pull-batch attempt row at start; the caller updates it via `recordPullBatchResult`. */
  recordPullBatchStart(aggregateIdx: number, pieceCids: string[]): number {
    const result = this.#db
      .prepare(
        `INSERT INTO pull_batch_attempts (aggregate_idx, started_at, piece_cids) VALUES (?, ?, ?)`
      )
      .run(aggregateIdx, new Date().toISOString(), JSON.stringify(pieceCids))
    return Number(result.lastInsertRowid)
  }

  recordPullBatchResult(id: number, ok: number, failed: number, error?: string): void {
    this.#db
      .prepare(`UPDATE pull_batch_attempts SET finished_at=?, ok_count=?, failed_count=?, error=? WHERE id=?`)
      .run(new Date().toISOString(), ok, failed, error ?? null, id)
  }

  /**
   * Aggregates submitted or parked but not yet committed. Submission backpressure
   * uses this so a run does not park more than maxParkedUncommitted at a time.
   */
  inFlightUncommittedCount(): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM aggregates WHERE status IN ('submitted', 'parked')`)
      .get() as { n: number }
    return Number(row.n)
  }

  counts(): { pending: number; processing: number; done: number; failed: number; oversized: number; total: number } {
    const row = this.#db
      .prepare(
        `SELECT
           SUM(status='pending')    AS pending,
           SUM(status='processing') AS processing,
           SUM(status='done')       AS done,
           SUM(status='failed')     AS failed,
           SUM(status='oversized')  AS oversized,
           COUNT(*)                 AS total
         FROM pieces`
      )
      .get() as Record<string, number | null>
    return {
      pending: Number(row.pending ?? 0),
      processing: Number(row.processing ?? 0),
      done: Number(row.done ?? 0),
      failed: Number(row.failed ?? 0),
      oversized: Number(row.oversized ?? 0),
      total: Number(row.total ?? 0),
    }
  }

  failures(): Array<{ cid: string; error: string; category: FailureCategory }> {
    const rows = this.#db
      .prepare(`SELECT cid, error, failure_category FROM pieces WHERE status='failed' ORDER BY cid`)
      .all()
    return rows.map((r) => {
      const row = r as Record<string, unknown>
      return {
        cid: String(row.cid),
        error: String(row.error ?? ''),
        category: (row.failure_category as FailureCategory | undefined) ?? 'other',
      }
    })
  }

  /** Counts of failed pieces by failure-category enum. Categories with zero count are omitted. */
  failuresByCategory(): Record<string, number> {
    const rows = this.#db
      .prepare(
        `SELECT COALESCE(failure_category, 'other') AS category, COUNT(*) AS n
         FROM pieces WHERE status='failed' GROUP BY category`
      )
      .all()
    const out: Record<string, number> = {}
    for (const r of rows) {
      const row = r as { category: string; n: number }
      out[row.category] = Number(row.n)
    }
    return out
  }

  /** Counts of aggregates by status. Statuses with zero count are omitted. */
  aggregatesByStatus(): Record<AggregateStatus, number> {
    const rows = this.#db.prepare(`SELECT status, COUNT(*) AS n FROM aggregates GROUP BY status`).all()
    const out: Record<string, number> = {}
    for (const r of rows) {
      const row = r as { status: string; n: number }
      out[row.status] = Number(row.n)
    }
    return out as Record<AggregateStatus, number>
  }

  close(): void {
    this.#db.close()
  }
}

function toPieceRow(r: unknown): PieceRow {
  const row = r as Record<string, unknown>
  return {
    cid: String(row.cid),
    pieceCid: row.piece_cid == null ? null : String(row.piece_cid),
    rawSize: row.raw_size == null ? null : Number(row.raw_size),
    gateway: row.gateway == null ? null : String(row.gateway),
    url: row.url == null ? null : String(row.url),
    status: row.status as PieceStatus,
    error: row.error == null ? null : String(row.error),
  }
}
