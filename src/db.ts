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
  carPath: string | null
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

  constructor(path: string) {
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
        cid           TEXT,
        sub_piece_cid TEXT,
        PRIMARY KEY (aggregate_idx, segment_index),
        FOREIGN KEY (cid) REFERENCES pieces(cid),
        FOREIGN KEY (sub_piece_cid) REFERENCES sub_pieces(sub_piece_cid),
        FOREIGN KEY (aggregate_idx) REFERENCES aggregates(idx)
      );
      CREATE TABLE IF NOT EXISTS sub_pieces (
        sub_piece_cid         TEXT PRIMARY KEY,
        assembled_car_length  INTEGER NOT NULL,
        assembled_sha256      TEXT,
        target_size_bytes     INTEGER NOT NULL,
        car_path              TEXT,
        status                TEXT NOT NULL DEFAULT 'planned',
        built_at              TEXT,
        error                 TEXT,
        created_at            TEXT NOT NULL
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

  /**
   * Persist an aggregate plus its ordered members. Each member is either a
   * single-piece source CID (`{ cid }`) or a packed multi-asset sub-piece
   * (`{ subPieceCid }`). The two shapes never mix inside one aggregate today,
   * but the table holds both columns so the redirect server can dispatch from
   * one lookup.
   */
  saveAggregate(
    idx: number,
    rootPieceCid: string,
    pieceSizeBytes: bigint,
    members: Array<string | { cid?: string; subPieceCid?: string }>
  ): void {
    this.#db
      .prepare(
        `INSERT INTO aggregates (idx, root_piece_cid, piece_size_bytes, status, created_at)
         VALUES (?, ?, ?, 'planned', ?)`
      )
      .run(idx, rootPieceCid, pieceSizeBytes.toString(), new Date().toISOString())
    const memberStmt = this.#db.prepare(
      `INSERT INTO aggregate_members (aggregate_idx, segment_index, cid, sub_piece_cid)
       VALUES (?, ?, ?, ?)`
    )
    members.forEach((m, segmentIndex) => {
      if (typeof m === 'string') {
        memberStmt.run(idx, segmentIndex, m, null)
      } else {
        memberStmt.run(idx, segmentIndex, m.cid ?? null, m.subPieceCid ?? null)
      }
    })
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

  /**
   * Manifest rows (`pieceCid`, `url`, `rawSize`) for one aggregate, in segment
   * order. Members may be either single-piece source CIDs or packed sub-pieces;
   * the columns coalesce so the caller sees a uniform `(pieceCid, url, rawSize)`
   * shape regardless of how the member was registered.
   */
  aggregateManifest(idx: number): Array<{ pieceCid: string; url: string; rawSize: number }> {
    const rows = this.#db
      .prepare(
        `SELECT
            COALESCE(sp.sub_piece_cid, p.piece_cid)   AS piece_cid,
            COALESCE(p.url, '')                       AS url,
            COALESCE(sp.assembled_car_length, p.raw_size) AS raw_size
         FROM aggregate_members m
         LEFT JOIN pieces p     ON p.cid = m.cid
         LEFT JOIN sub_pieces sp ON sp.sub_piece_cid = m.sub_piece_cid
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

  /**
   * Insert a planned sub-piece row plus its ordered member list in one
   * transaction. Members are addressed by their source CID and recorded in the
   * canonical sort order computed at plan time (parsed-CID-bytes ascending).
   * The assembled CAR length is computed up-front so the redirect server can
   * set `Content-Length` without re-walking the bytes.
   */
  recordPlannedSubPiece(args: {
    subPieceCid: string
    assembledCarLength: number
    targetSizeBytes: number
    members: Array<{ cid: string; rawSize: number | null; sha256: string | null }>
  }): void {
    const now = new Date().toISOString()
    const insertSub = this.#db.prepare(
      `INSERT INTO sub_pieces (sub_piece_cid, assembled_car_length, target_size_bytes, status, created_at)
       VALUES (?, ?, ?, 'planned', ?)
       ON CONFLICT(sub_piece_cid) DO NOTHING`
    )
    const insertMember = this.#db.prepare(
      `INSERT INTO sub_piece_members
         (sub_piece_cid, member_cid, member_sort_order, member_sha256, member_raw_size)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sub_piece_cid, member_cid) DO NOTHING`
    )
    insertSub.run(args.subPieceCid, args.assembledCarLength, args.targetSizeBytes, now)
    args.members.forEach((m, i) => {
      insertMember.run(args.subPieceCid, m.cid, i, m.sha256, m.rawSize)
    })
  }

  /**
   * Transition a planned sub-piece to `built`: the assembled CAR is on disk
   * (under `--car-store`), its sha256 matched the planning digest, and the
   * server may serve it for pulls.
   */
  markSubPieceBuilt(subPieceCid: string, carPath: string, assembledSha256: string): void {
    this.#db
      .prepare(
        `UPDATE sub_pieces SET status='built', car_path=?, assembled_sha256=?, built_at=?, error=NULL
         WHERE sub_piece_cid=?`
      )
      .run(carPath, assembledSha256, new Date().toISOString(), subPieceCid)
  }

  markSubPieceFailed(subPieceCid: string, error: string): void {
    this.#db
      .prepare(`UPDATE sub_pieces SET status='failed', error=? WHERE sub_piece_cid=?`)
      .run(error, subPieceCid)
  }

  /** Look up a sub-piece by its packed PieceCID v2. Null when no row exists. */
  subPieceByCid(subPieceCid: string): SubPieceRow | null {
    const row = this.#db
      .prepare(
        `SELECT sub_piece_cid, assembled_car_length, assembled_sha256, target_size_bytes,
                car_path, status FROM sub_pieces WHERE sub_piece_cid = ? LIMIT 1`
      )
      .get(subPieceCid) as Record<string, unknown> | undefined
    if (row == null) return null
    return {
      subPieceCid: String(row.sub_piece_cid),
      assembledCarLength: Number(row.assembled_car_length),
      assembledSha256: row.assembled_sha256 == null ? null : String(row.assembled_sha256),
      targetSizeBytes: Number(row.target_size_bytes),
      carPath: row.car_path == null ? null : String(row.car_path),
      status: row.status as SubPieceStatus,
    }
  }

  /** Sub-pieces in the given status. */
  subPiecesByStatus(status: SubPieceStatus): SubPieceRow[] {
    const rows = this.#db
      .prepare(
        `SELECT sub_piece_cid, assembled_car_length, assembled_sha256, target_size_bytes,
                car_path, status FROM sub_pieces WHERE status = ? ORDER BY sub_piece_cid`
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
        status: row.status as SubPieceStatus,
      }
    })
  }

  /** Sub-piece member CIDs locked into a planned sub-piece (cannot be re-packed). */
  lockedSubPieceMemberCids(): Set<string> {
    const rows = this.#db
      .prepare(`SELECT member_cid FROM sub_piece_members`)
      .all()
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

  /** Pieces marked done that are not already locked into a sub-piece or in-flight aggregate. */
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
