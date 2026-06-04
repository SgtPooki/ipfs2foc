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
  | 'source_gateway_network'
  | 'source_gateway_timeout'
  | 'car_root_mismatch'
  | 'commp_mismatch'
  | 'oversized'
  | 'pull_cap_exceeded'
  | 'byte_unstable'
  | 'unservable_fallback_only'
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
// `add_unconfirmed`: an AddPieces was attempted (tx may or may not have been
// broadcast/landed) but the outcome is not yet confirmed on chain. Distinct from
// `failed` so it is never auto-reset into a blind re-add — a second AddPieces for
// the same root would be a duplicate on-chain commit. Resolved by reconciling
// against `activePieceCids` (commit if the root is on chain) or, once the
// operator confirms the root is absent, `resetUnconfirmedAggregates`.
export type AggregateStatus = 'planned' | 'submitted' | 'parked' | 'add_unconfirmed' | 'committed' | 'failed'

/**
 * Packed sub-piece lifecycle. A sub-piece is a synthetic multi-root CAR that
 * groups M source CIDs into one PDP sub-piece. `planned` means the bin layout
 * is committed but the bytes have not been assembled; `built` means the
 * assembled CAR is on disk (under `--car-store`) and its commitment matched.
 * `failed` is set if assembly produced a different commitment than planned.
 */
export type SubPieceStatus = 'planned' | 'built' | 'failed'

export interface SubPieceRow {
  subPieceCid: string
  assembledCarLength: number
  assembledSha256: string | null
  targetSizeBytes: number
  /** Local CAR file for assembled multi-asset sub-pieces. Null for passthrough. */
  carPath: string | null
  /** Source-gateway URL for passthrough sub-pieces (single source CID). Null for assembled. */
  url: string | null
  status: SubPieceStatus
}

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
  /** The sqlite file path this instance opened, so callers can echo it back. */
  readonly path: string

  constructor(path: string) {
    this.path = path
    this.#db = new DatabaseSync(path)
    // busy_timeout must come before any other exec: even setting WAL needs
    // the write lock, and a sibling process holding it will error out the
    // very first pragma without this. Without busy_timeout, the sqlite layer
    // surfaces SQLITE_BUSY as `disk I/O error`.
    this.#db.exec('PRAGMA busy_timeout = 5000')
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#migrate()
  }

  #migrate(): void {
    // No ALTERs: schema is unreleased, so each new column joins the CREATE
    // statement directly. sub_pieces / sub_piece_members hold the packed
    // multi-root CAR groups (each one is a single PDP sub-piece). The
    // aggregate_members table is the single point that previously joined an
    // aggregate to its members; the new `sub_piece_cid` column points at a
    // packed group when present, and falls back to `cid` (single-piece path).
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
        member_sha256    TEXT,
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
        sub_piece_cid TEXT NOT NULL,
        PRIMARY KEY (aggregate_idx, segment_index),
        FOREIGN KEY (sub_piece_cid) REFERENCES sub_pieces(sub_piece_cid),
        FOREIGN KEY (aggregate_idx) REFERENCES aggregates(idx)
      );
      CREATE TABLE IF NOT EXISTS sub_pieces (
        sub_piece_cid         TEXT PRIMARY KEY,
        assembled_car_length  INTEGER NOT NULL,
        assembled_sha256      TEXT,
        target_size_bytes     INTEGER NOT NULL,
        car_path              TEXT,
        url                   TEXT,
        status                TEXT NOT NULL DEFAULT 'planned',
        built_at              TEXT,
        error                 TEXT,
        created_at            TEXT NOT NULL,
        CHECK ((car_path IS NULL) != (url IS NULL))
      );
      CREATE TABLE IF NOT EXISTS sub_piece_members (
        sub_piece_cid     TEXT NOT NULL,
        member_cid        TEXT NOT NULL,
        member_sort_order INTEGER NOT NULL,
        member_sha256     TEXT,
        member_raw_size   INTEGER,
        PRIMARY KEY (sub_piece_cid, member_cid),
        FOREIGN KEY (sub_piece_cid) REFERENCES sub_pieces(sub_piece_cid),
        FOREIGN KEY (member_cid) REFERENCES pieces(cid)
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

  recordPieceSuccess(
    cid: string,
    pieceCid: string,
    rawSize: number,
    gateway: string,
    url: string,
    memberSha256?: string | null
  ): void {
    // `member_sha256` is captured here so pack-cars can later refuse to assemble
    // if the source gateway returns drifted bytes. Optional on the call site so
    // the call shape stays backward-compatible for callers that have not been
    // updated.
    this.#db
      .prepare(
        `UPDATE pieces SET piece_cid=?, raw_size=?, gateway=?, url=?,
                            member_sha256=?, status='done', error=NULL, updated_at=?
         WHERE cid=?`
      )
      .run(pieceCid, rawSize, gateway, url, memberSha256 ?? null, new Date().toISOString(), cid)
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
    this.#db.prepare(`UPDATE pieces SET status='done', failure_category=NULL WHERE status='oversized'`).run()
  }

  /** All successfully-computed pieces, in stable order, for packing. */
  donePieces(): PieceRow[] {
    const rows = this.#db
      .prepare(
        `SELECT cid, piece_cid, raw_size, gateway, url, status, error FROM pieces WHERE status='done' ORDER BY cid`
      )
      .all()
    return rows.map(toPieceRow)
  }

  /**
   * Source CIDs already locked into an aggregate that has been submitted or
   * beyond. Walks the sub-piece member set so a passthrough sub-piece (one
   * source CID) and a multi-asset sub-piece (N source CIDs) are both
   * excluded from re-packing.
   */
  lockedMemberCids(): Set<string> {
    const rows = this.#db
      .prepare(
        `SELECT spm.member_cid
         FROM aggregate_members m
         JOIN aggregates a ON a.idx = m.aggregate_idx
         JOIN sub_piece_members spm ON spm.sub_piece_cid = m.sub_piece_cid
         WHERE a.status != 'planned'`
      )
      .all()
    return new Set(rows.map((r) => String((r as { member_cid: string }).member_cid)))
  }

  /** Next free aggregate index, above any existing (including submitted) aggregate. */
  nextAggregateIndex(): number {
    const row = this.#db.prepare(`SELECT COALESCE(MAX(idx), -1) AS m FROM aggregates`).get() as { m: number }
    return Number(row.m) + 1
  }

  /**
   * Persist an aggregate plus its ordered sub-piece members. Every member is
   * a sub-piece — single-asset source CIDs become 1-member passthrough
   * sub-pieces at plan time, so the pull/add path has one canonical shape.
   */
  saveAggregate(idx: number, rootPieceCid: string, pieceSizeBytes: bigint, members: string[]): void {
    const aggregateStmt = this.#db.prepare(
      `INSERT INTO aggregates (idx, root_piece_cid, piece_size_bytes, status, created_at)
       VALUES (?, ?, ?, 'planned', ?)`
    )
    const memberStmt = this.#db.prepare(
      `INSERT INTO aggregate_members (aggregate_idx, segment_index, sub_piece_cid)
       VALUES (?, ?, ?)`
    )
    // The aggregate row and its members land together or not at all — a crash
    // between them would leave a planned aggregate whose stored root no longer
    // matches its persisted members. Same atomicity contract as the
    // recordBuiltSubPiece / recordPassthroughSubPiece writers.
    this.#db.exec('BEGIN')
    try {
      aggregateStmt.run(idx, rootPieceCid, pieceSizeBytes.toString(), new Date().toISOString())
      members.forEach((subPieceCid, segmentIndex) => {
        memberStmt.run(idx, segmentIndex, subPieceCid)
      })
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
  }

  aggregates(): AggregateRow[] {
    // `member_count` is the *source-CID* count, expanding packed sub-pieces
    // through `sub_piece_members`. A 48-CID packed aggregate reports 48, not
    // 1, so operator-facing counters (report, status) reflect input shape.
    const rows = this.#db
      .prepare(
        `SELECT a.idx, a.root_piece_cid, a.piece_size_bytes, a.status, a.pull_id,
                a.data_set_id, a.piece_id, a.tx_hash, a.committed_block, a.error,
                a.submitted_at, a.parked_at, a.committed_at,
                (
                  SELECT COUNT(*)
                  FROM aggregate_members m
                  JOIN sub_piece_members spm ON spm.sub_piece_cid = m.sub_piece_cid
                  WHERE m.aggregate_idx = a.idx
                ) AS member_count
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

  /**
   * Source CIDs (input list) belonging to one aggregate. Always walks
   * `sub_piece_members` since every aggregate member is a sub-piece —
   * passthrough sub-pieces have one member CID equal to the source CID, and
   * multi-asset sub-pieces have N members. Returned in the canonical packing
   * order: segment of the aggregate, then sort order within the sub-piece.
   */
  aggregateAssetCids(idx: number): string[] {
    const rows = this.#db
      .prepare(
        `SELECT spm.member_cid
         FROM aggregate_members m
         JOIN sub_piece_members spm ON spm.sub_piece_cid = m.sub_piece_cid
         WHERE m.aggregate_idx = ?
         ORDER BY m.segment_index, spm.member_sort_order`
      )
      .all(idx) as Array<{ member_cid: string }>
    return rows.map((r) => String(r.member_cid))
  }

  /** Number of source-CID assets in one aggregate. */
  aggregateAssetCount(idx: number): number {
    return this.aggregateAssetCids(idx).length
  }

  /**
   * Distinct source CIDs committed across the given on-chain aggregates.
   * Membership in "on chain" is decided by `report` (root match against the
   * verifier), so it passes the on-chain aggregate indexes in. `inPieces` counts
   * only those that exist in the local `pieces` table; `total - inPieces` is the
   * count committed on chain but absent locally — a real discrepancy the old
   * `max(0, …)` clamping silently absorbed. `COUNT(DISTINCT …)` dedupes a CID
   * that lands in more than one committed aggregate (e.g. a passthrough and a
   * packed aggregate over the same source), and the SQL aggregation keeps this
   * scale-safe — no CID list is materialized.
   */
  committedSourceCidStats(onChainAggregateIdxs: number[]): { inPieces: number; total: number } {
    if (onChainAggregateIdxs.length === 0) return { inPieces: 0, total: 0 }
    const placeholders = onChainAggregateIdxs.map(() => '?').join(',')
    const total = this.#db
      .prepare(
        `SELECT COUNT(DISTINCT spm.member_cid) AS n
           FROM aggregate_members m
           JOIN sub_piece_members spm ON spm.sub_piece_cid = m.sub_piece_cid
          WHERE m.aggregate_idx IN (${placeholders})`
      )
      .get(...onChainAggregateIdxs) as { n: number }
    const inPieces = this.#db
      .prepare(
        `SELECT COUNT(DISTINCT spm.member_cid) AS n
           FROM aggregate_members m
           JOIN sub_piece_members spm ON spm.sub_piece_cid = m.sub_piece_cid
           JOIN pieces p ON p.cid = spm.member_cid
          WHERE m.aggregate_idx IN (${placeholders})`
      )
      .get(...onChainAggregateIdxs) as { n: number }
    return { inPieces: Number(inPieces.n), total: Number(total.n) }
  }

  /**
   * Sub-piece manifest for one aggregate, in segment order. Every row is one
   * sub-piece (multi-asset CAR file or passthrough source-gateway URL); the
   * pull/add path treats them uniformly.
   */
  aggregateManifest(idx: number): Array<{ pieceCid: string; url: string; rawSize: number }> {
    const rows = this.#db
      .prepare(
        `SELECT
            sp.sub_piece_cid      AS piece_cid,
            COALESCE(sp.url, '')  AS url,
            sp.assembled_car_length AS raw_size
         FROM aggregate_members m
         JOIN sub_pieces sp ON sp.sub_piece_cid = m.sub_piece_cid
         WHERE m.aggregate_idx = ?
         ORDER BY m.segment_index`
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
   * Persist the AddPieces tx hash as soon as the provider returns it, before
   * the receipt poll completes. A process kill between the tx submission and
   * the receipt parse leaves the row in `parked` with a non-null `tx_hash`;
   * `aggregatesAwaitingReceipt` picks those up on restart so the migrator
   * resumes from the receipt step instead of re-pulling and re-adding.
   */
  markAggregateTxSubmitted(idx: number, txHash: string): void {
    this.#db.prepare(`UPDATE aggregates SET tx_hash=? WHERE idx=?`).run(txHash, idx)
  }

  /**
   * Mark an aggregate as having an attempted-but-unconfirmed AddPieces. Set this
   * immediately before the provider add call, so a process kill mid-add (tx
   * broadcast, no response persisted) and a provider error that returns no tx
   * hash both leave a durable breadcrumb. The submit resume path reconciles such
   * a row against the chain instead of re-adding it (which would land a
   * duplicate AddPieces tx for the same root). Never reset by
   * `resetFailedAggregates`; see `resetUnconfirmedAggregates`.
   */
  markAggregateAddUnconfirmed(idx: number, error?: string): void {
    this.#db
      .prepare(`UPDATE aggregates SET status='add_unconfirmed', error=COALESCE(?, error) WHERE idx=?`)
      .run(error ?? null, idx)
  }

  /**
   * Re-arm `add_unconfirmed` aggregates back to `planned`, clearing the stale tx
   * hash so the next run re-pulls and re-adds. Only safe after the operator has
   * confirmed the aggregate's root is absent on chain — otherwise this is the
   * lever that creates a duplicate AddPieces. Separate from
   * `resetFailedAggregates` precisely so a bulk failed-reset cannot trigger it.
   */
  resetUnconfirmedAggregates(): number {
    const result = this.#db
      .prepare(`UPDATE aggregates SET status='planned', tx_hash=NULL, error=NULL WHERE status='add_unconfirmed'`)
      .run()
    return Number(result.changes)
  }

  /** Aggregates whose AddPieces tx is in flight but whose local commit row has not landed yet. */
  aggregatesAwaitingReceipt(): AggregateRow[] {
    return this.aggregates().filter((a) => a.txHash != null && a.status !== 'committed')
  }

  /**
   * Record the on-chain AddPiece: data set, piece id, transaction hash, and the
   * receipt's block number. The block number is set only when the PiecesAdded
   * event was parsed and matched against the local aggregate root; absence
   * marks an unverified commit (see `markCommittedUnverified`).
   */
  markCommitted(
    idx: number,
    info: {
      dataSetId: string
      pieceId?: string
      txHash?: string
      committedBlock?: string
    }
  ): void {
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
    // Once the AddPieces receipt is on-chain, the source-gateway URLs for the
    // aggregate's sub-piece members are no longer needed; the provider already
    // pulled and verified every byte. Cached CAR files are returned to the
    // caller as a side-effect so the caller can unlink them (db.ts stays
    // filesystem-free).
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
      .run(info.dataSetId, info.pieceId ?? null, info.txHash ?? null, info.reason, new Date().toISOString(), idx)
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
    const result = this.#db.prepare(`UPDATE aggregates SET status='planned', error=NULL WHERE status='failed'`).run()
    return Number(result.changes)
  }

  /** Insert a pull-batch attempt row at start; the caller updates it via `recordPullBatchResult`. */
  recordPullBatchStart(aggregateIdx: number, pieceCids: string[]): number {
    const result = this.#db
      .prepare(`INSERT INTO pull_batch_attempts (aggregate_idx, started_at, piece_cids) VALUES (?, ?, ?)`)
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
      .prepare(`SELECT COUNT(*) AS n FROM aggregates WHERE status IN ('submitted', 'parked', 'add_unconfirmed')`)
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

  /**
   * Insert a planned sub-piece row plus its ordered member list in one
   * transaction. Members are addressed by their source CID and recorded in the
   * canonical sort order computed at plan time (parsed-CID-bytes ascending).
   * The assembled CAR length is computed up-front so the redirect server can
   * set `Content-Length` without re-walking the bytes.
   */
  markSubPieceFailed(subPieceCid: string, error: string): void {
    this.#db.prepare(`UPDATE sub_pieces SET status='failed', error=? WHERE sub_piece_cid=?`).run(error, subPieceCid)
  }

  /**
   * Insert a sub-piece row in `built` status together with its member rows in
   * one transaction. Replaces the historic `recordPlannedSubPiece` +
   * `markSubPieceBuilt` pair, which were two separate statements masquerading
   * as atomic — a crash between them stranded the sub-piece (members locked,
   * row stuck `planned`, no recovery pass).
   */
  recordBuiltSubPiece(args: {
    subPieceCid: string
    assembledCarLength: number
    targetSizeBytes: number
    carPath: string
    assembledSha256: string
    members: Array<{ cid: string; rawSize: number | null; sha256: string | null }>
  }): void {
    const now = new Date().toISOString()
    const insertSub = this.#db.prepare(
      `INSERT INTO sub_pieces (sub_piece_cid, assembled_car_length, target_size_bytes,
                                status, car_path, assembled_sha256, built_at, created_at)
       VALUES (?, ?, ?, 'built', ?, ?, ?, ?)`
    )
    const insertMember = this.#db.prepare(
      `INSERT INTO sub_piece_members (sub_piece_cid, member_cid, member_sort_order, member_sha256, member_raw_size)
       VALUES (?, ?, ?, ?, ?)`
    )
    this.#db.exec('BEGIN')
    try {
      insertSub.run(
        args.subPieceCid,
        args.assembledCarLength,
        args.targetSizeBytes,
        args.carPath,
        args.assembledSha256,
        now,
        now
      )
      args.members.forEach((m, i) => {
        insertMember.run(args.subPieceCid, m.cid, i, m.sha256, m.rawSize)
      })
      this.#db.exec('COMMIT')
      return
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * Insert a passthrough sub-piece — one source CID wrapped as a single-member
   * sub-piece whose pull source is the gateway URL. No CAR file on disk.
   * Same atomicity contract as `recordBuiltSubPiece`: sub_piece row + the
   * single member row land together or not at all.
   */
  recordPassthroughSubPiece(args: {
    subPieceCid: string
    sourceCid: string
    url: string
    rawSize: number
    memberSha256: string | null
  }): void {
    const now = new Date().toISOString()
    this.#db.exec('BEGIN')
    try {
      this.#db
        .prepare(
          `INSERT INTO sub_pieces (sub_piece_cid, assembled_car_length, target_size_bytes,
                                    status, url, assembled_sha256, built_at, created_at)
           VALUES (?, ?, ?, 'built', ?, ?, ?, ?)`
        )
        .run(args.subPieceCid, args.rawSize, args.rawSize, args.url, args.memberSha256, now, now)
      this.#db
        .prepare(
          `INSERT INTO sub_piece_members (sub_piece_cid, member_cid, member_sort_order, member_sha256, member_raw_size)
           VALUES (?, ?, 0, ?, ?)`
        )
        .run(args.subPieceCid, args.sourceCid, args.memberSha256, args.rawSize)
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
  }

  /** Look up a sub-piece by its packed PieceCID v2. Null when no row exists. */
  subPieceByCid(subPieceCid: string): SubPieceRow | null {
    const row = this.#db
      .prepare(
        `SELECT sub_piece_cid, assembled_car_length, assembled_sha256, target_size_bytes,
                car_path, url, status FROM sub_pieces WHERE sub_piece_cid = ? LIMIT 1`
      )
      .get(subPieceCid) as Record<string, unknown> | undefined
    if (row == null) return null
    return {
      subPieceCid: String(row.sub_piece_cid),
      assembledCarLength: Number(row.assembled_car_length),
      assembledSha256: row.assembled_sha256 == null ? null : String(row.assembled_sha256),
      targetSizeBytes: Number(row.target_size_bytes),
      carPath: row.car_path == null ? null : String(row.car_path),
      url: row.url == null ? null : String(row.url),
      status: row.status as SubPieceStatus,
    }
  }

  /** Sub-pieces in the given status. */
  subPiecesByStatus(status: SubPieceStatus): SubPieceRow[] {
    const rows = this.#db
      .prepare(
        `SELECT sub_piece_cid, assembled_car_length, assembled_sha256, target_size_bytes,
                car_path, url, status FROM sub_pieces WHERE status = ? ORDER BY sub_piece_cid`
      )
      .all(status)
    return rows.map((r) => {
      const row = r as Record<string, unknown>
      return {
        subPieceCid: String(row.sub_piece_cid),
        assembledCarLength: Number(row.assembled_car_length),
        assembledSha256: row.assembled_sha256 == null ? null : String(row.assembled_sha256),
        targetSizeBytes: Number(row.target_size_bytes),
        carPath: row.car_path == null ? null : String(row.car_path),
        url: row.url == null ? null : String(row.url),
        status: row.status as SubPieceStatus,
      }
    })
  }

  /** Sub-piece member CIDs locked into a planned sub-piece (cannot be re-packed). */
  lockedSubPieceMemberCids(): Set<string> {
    const rows = this.#db.prepare(`SELECT member_cid FROM sub_piece_members`).all()
    return new Set(rows.map((r) => String((r as { member_cid: string }).member_cid)))
  }

  /**
   * Ordered member CIDs of a sub-piece (sort order set at plan time). The
   * redirect server uses this in the stream-assemble path so it can re-fetch
   * members and concatenate them in the same order the piece commitment was
   * computed against.
   */
  subPieceMemberCids(subPieceCid: string): string[] {
    const rows = this.#db
      .prepare(
        `SELECT member_cid FROM sub_piece_members
         WHERE sub_piece_cid = ? ORDER BY member_sort_order`
      )
      .all(subPieceCid)
    return rows.map((r) => String((r as { member_cid: string }).member_cid))
  }

  /** Sub-piece CIDs that already belong to an aggregate (any status). */
  subPieceCidsAlreadyAggregated(): Set<string> {
    const rows = this.#db.prepare(`SELECT DISTINCT sub_piece_cid FROM aggregate_members`).all() as Array<{
      sub_piece_cid: string
    }>
    return new Set(rows.map((r) => String(r.sub_piece_cid)))
  }

  /**
   * Pieces marked done that have not yet been wrapped into a sub-piece.
   * Membership in any sub-piece (passthrough or packed) excludes a piece;
   * lifecycle status of the aggregate containing that sub-piece does not
   * matter because composition is set at INSERT and never mutates.
   */
  donePiecesFreeForPacking(): PieceRow[] {
    const rows = this.#db
      .prepare(
        `SELECT p.cid, p.piece_cid, p.raw_size, p.gateway, p.url, p.status, p.error
         FROM pieces p
         WHERE p.status='done'
           AND p.cid NOT IN (SELECT member_cid FROM sub_piece_members)
         ORDER BY p.cid`
      )
      .all()
    return rows.map(toPieceRow)
  }

  /**
   * Delete cached sub-piece CARs for an aggregate. Called from `markCommitted`
   * once the aggregate is on-chain: the gateways are no longer needed and the
   * disk space can come back. Returns the file paths the caller should unlink.
   *
   * This is the single eviction trigger point. Doing it earlier risks racing a
   * provider retry from byte 0; doing it later wastes disk for the production
   * persona that runs `--max-in-flight 1` against a 32 GiB free disk.
   */
  carPathsForAggregateOnCommit(aggregateIdx: number): string[] {
    const rows = this.#db
      .prepare(
        `SELECT sp.car_path
         FROM aggregate_members am
         JOIN sub_pieces sp ON sp.sub_piece_cid = am.sub_piece_cid
         WHERE am.aggregate_idx = ? AND sp.car_path IS NOT NULL`
      )
      .all(aggregateIdx)
    return rows
      .map((r) => (r as { car_path: string | null }).car_path)
      .filter((p): p is string => p != null && p !== '')
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
