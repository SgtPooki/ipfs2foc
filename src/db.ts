/**
 * State store, backed by Node's built-in node:sqlite (no dependency).
 *
 * The database is the single source of truth for a migration run: each CID's
 * piece commitment, the aggregates it was packed into, and per-step status. A
 * run resumes from here after any interruption.
 */

import { DatabaseSync } from 'node:sqlite'

export type PieceStatus = 'pending' | 'processing' | 'done' | 'failed'

/**
 * Aggregate lifecycle.
 *
 *   planned    packed locally, not yet sent to a storage provider
 *   submitted  mk20 deal accepted; the provider is pulling sub-pieces
 *   parked     every sub-piece downloaded and verified by the provider; the
 *              gateways are not needed past this point, but nothing is on-chain yet
 *   committed  AddPiece is on-chain; the aggregate piece CID and data set are final
 *   failed     the deal was rejected, or a sub-piece could not be pulled or verified
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
  /** Aggregate root PieceCID v2 — the finalized parent CID for the aggregate,
   *  passed to `sptool ... --pcidv2` and pointed to once committed. */
  rootPieceCid: string
  pieceSizeBytes: string
  status: AggregateStatus
  dealId: string | null
  /** On-chain PDP data set + piece the aggregate was committed to. */
  dataSetId: string | null
  pieceId: string | null
  txHash: string | null
  memberCount: number
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
        cid        TEXT PRIMARY KEY,
        piece_cid  TEXT,
        raw_size   INTEGER,
        gateway    TEXT,
        url        TEXT,
        status     TEXT NOT NULL DEFAULT 'pending',
        error      TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS aggregates (
        idx              INTEGER PRIMARY KEY,
        root_piece_cid   TEXT NOT NULL,
        piece_size_bytes TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'planned',
        deal_id          TEXT,
        data_set_id      TEXT,
        piece_id         TEXT,
        tx_hash          TEXT,
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

  recordPieceFailure(cid: string, error: string): void {
    this.#db
      .prepare(`UPDATE pieces SET status='failed', error=?, updated_at=? WHERE cid=?`)
      .run(error, new Date().toISOString(), cid)
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
        `SELECT a.idx, a.root_piece_cid, a.piece_size_bytes, a.status, a.deal_id,
                a.data_set_id, a.piece_id, a.tx_hash,
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
        dealId: str(row.deal_id),
        dataSetId: str(row.data_set_id),
        pieceId: str(row.piece_id),
        txHash: str(row.tx_hash),
        memberCount: Number(row.member_count),
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

  /** Record that the mk20 deal was accepted and the provider is pulling sub-pieces. */
  markSubmitted(idx: number, dealId: string): void {
    this.#db
      .prepare(`UPDATE aggregates SET status='submitted', deal_id=?, submitted_at=? WHERE idx=?`)
      .run(dealId, new Date().toISOString(), idx)
  }

  /** Record that every sub-piece is downloaded and verified; gateways not needed past this point. */
  markParked(idx: number): void {
    this.#db
      .prepare(`UPDATE aggregates SET status='parked', parked_at=? WHERE idx=?`)
      .run(new Date().toISOString(), idx)
  }

  /** Record the on-chain AddPiece: data set, piece id, and transaction hash. */
  markCommitted(idx: number, info: { dataSetId: string; pieceId?: string; txHash?: string }): void {
    this.#db
      .prepare(
        `UPDATE aggregates SET status='committed', data_set_id=?, piece_id=?, tx_hash=?, committed_at=? WHERE idx=?`
      )
      .run(info.dataSetId, info.pieceId ?? null, info.txHash ?? null, new Date().toISOString(), idx)
  }

  markAggregateFailed(idx: number): void {
    this.#db.prepare(`UPDATE aggregates SET status='failed' WHERE idx=?`).run(idx)
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

  counts(): { pending: number; processing: number; done: number; failed: number } {
    const row = this.#db
      .prepare(
        `SELECT
           SUM(status='pending')    AS pending,
           SUM(status='processing') AS processing,
           SUM(status='done')       AS done,
           SUM(status='failed')     AS failed
         FROM pieces`
      )
      .get() as Record<string, number | null>
    return {
      pending: Number(row.pending ?? 0),
      processing: Number(row.processing ?? 0),
      done: Number(row.done ?? 0),
      failed: Number(row.failed ?? 0),
    }
  }

  failures(): Array<{ cid: string; error: string }> {
    const rows = this.#db.prepare(`SELECT cid, error FROM pieces WHERE status='failed' ORDER BY cid`).all()
    return rows.map((r) => {
      const row = r as Record<string, unknown>
      return { cid: String(row.cid), error: String(row.error ?? '') }
    })
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
