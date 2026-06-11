// IndexedDB persistence for the prepare run (#26). A refresh, accidental tab
// close, or a discarded idle tab no longer loses the CID list or the computed
// pieces — on load the app restores them and recomputes only what's missing.
// Computed pieces are deterministic, so restoring a done row is always safe.
//
// IndexedDB over localStorage: result sets grow with the CID list, and a future
// per-piece byte cache needs more than string storage. Everything is
// best-effort — private windows and storage-denied contexts degrade to the
// old non-persistent behavior, never to an error the user sees.
import type { PieceResult } from './commp.ts'

const DB_NAME = 'ipfs2foc'
const STORE = 'prepare-run'
const KEY = 'current'
const SUBMIT_KEY = 'submit'

export interface SavedRun {
  cidsText: string
  /** Name of the loaded cids.txt, when the run's list came from a file (#50). */
  fileName?: string
  /** Accepted CIDs parsed from that file — kept out of `cidsText` so the
   *  textarea never holds a multi-megabyte inventory. */
  fileCids?: string[]
  /** Rejected-line count from the file parse, restored for the intake summary. */
  fileInvalidCount?: number
  gateway: string
  relayBase: string
  /** Completed pieces keyed by the CID string as the user entered it. */
  results: Record<string, PieceResult>
  updatedAt: string
}

/**
 * One pull/commit chunk of a provider copy. Providers cap the pieces per pull
 * request, so a run is split into chunks, each with its own presign and its
 * own on-chain add. Everything needed to resume a chunk after a reload
 * WITHOUT re-signing or re-submitting:
 * - `extraData` is the presigned authorization — the provider's pull endpoint
 *   is idempotent keyed on it, so re-pulling with the same blob is safe;
 *   presigning again would mint a different blob and a duplicate request.
 * - `txHash` (+ `signedDataSetId` when the presign targeted an existing data
 *   set) is recorded the moment commit submits; a resumed run polls the
 *   provider's status URL reconstructed from these instead of ever re-posting
 *   commit.
 * All bigints are stored as strings so the record survives JSON round-trips.
 */
export interface SavedChunk {
  /** This chunk's PieceCIDs, fixed when the run was planned — resume reuses them. */
  pieceCids: string[]
  extraData?: `0x${string}`
  /**
   * Data set the presign targeted: present means the extraData is an
   * AddPieces blob for that set, absent means create-and-add. A resumed
   * chunk whose resolved data set differs must discard the extraData (and
   * may, because nothing was submitted yet once txHash is absent).
   */
  signedDataSetId?: string
  pullComplete?: boolean
  txHash?: `0x${string}`
  pieceIds?: string[]
  /** The chunk's add confirmed on chain. */
  committed?: boolean
}

export interface SavedSubmitContext {
  role: 'primary' | 'secondary'
  providerId: string
  providerName: string
  serviceURL: string
  /** Resolved after this copy's first committed chunk; later chunks add to it. */
  dataSetId?: string
  /** Aggregate of the committed chunks' piece ids (display convenience). */
  pieceIds?: string[]
  chunks: SavedChunk[]
  /**
   * Pieces this provider could not fetch from their source after retries.
   * They are carved out of their chunk so the rest commits; the UI offers a
   * remainder manifest and a requeue.
   */
  deferredPieceCids?: string[]
  error?: string
}

export interface SavedSubmit {
  /** Bump on shape changes; loadSubmit migrates or discards older records. */
  version: 2
  /** Wallet + network the run was signed under — a different pair must not resume it. */
  root: `0x${string}`
  chainId: number
  copies: number
  /** PieceCIDs covered by this run (across all chunks), sorted. */
  pieceCids: string[]
  contexts: SavedSubmitContext[]
  updatedAt: string
}

/** The pre-chunking record shape (no version field). */
interface LegacySavedSubmit {
  root: `0x${string}`
  chainId: number
  copies: number
  pieceCids: string[]
  updatedAt: string
  contexts: Array<{
    role: 'primary' | 'secondary'
    providerId: string
    providerName: string
    serviceURL: string
    extraData?: `0x${string}`
    signedDataSetId?: string
    pullComplete?: boolean
    txHash?: `0x${string}`
    dataSetId?: string
    pieceIds?: string[]
    error?: string
  }>
}

/** Chunk size for re-planned legacy records; keep equal to submit.ts PULL_CHUNK_SIZE. */
export const PULL_CHUNK_SIZE = 32

/**
 * A legacy record was a one-shot run. With a txHash the submission is the
 * provider's to land — carry it over as a single confirmation-only chunk.
 * Without one, nothing was submitted: discard the whole-run presign (it can
 * exceed the provider's per-pull cap) and re-plan into proper chunks.
 */
function migrateLegacySubmit(old: LegacySavedSubmit): SavedSubmit | null {
  if (!Array.isArray(old.contexts) || !Array.isArray(old.pieceCids)) return null
  const replanned = (): SavedChunk[] => {
    const chunks: SavedChunk[] = []
    for (let i = 0; i < old.pieceCids.length; i += PULL_CHUNK_SIZE) {
      chunks.push({ pieceCids: old.pieceCids.slice(i, i + PULL_CHUNK_SIZE) })
    }
    return chunks
  }
  return {
    version: 2,
    root: old.root,
    chainId: old.chainId,
    copies: old.copies,
    pieceCids: old.pieceCids,
    updatedAt: old.updatedAt,
    contexts: old.contexts.map((c) => ({
      role: c.role,
      providerId: c.providerId,
      providerName: c.providerName,
      serviceURL: c.serviceURL,
      dataSetId: c.dataSetId,
      pieceIds: c.pieceIds,
      error: c.error,
      chunks:
        c.txHash == null
          ? replanned()
          : [
              {
                pieceCids: old.pieceCids,
                extraData: c.extraData,
                signedDataSetId: c.signedDataSetId,
                pullComplete: c.pullComplete,
                txHash: c.txHash,
                pieceIds: c.pieceIds,
                committed: c.dataSetId != null && c.pieceIds != null,
              },
            ],
    })),
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export async function loadRun(): Promise<SavedRun | null> {
  try {
    return ((await withStore('readonly', (s) => s.get(KEY))) as SavedRun | undefined) ?? null
  } catch {
    return null
  }
}

export async function saveRun(run: SavedRun): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.put(run, KEY))
  } catch {
    // best-effort: storage denied or private window
  }
}

export async function clearRun(): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(KEY))
  } catch {
    // best-effort
  }
}

export async function loadSubmit(): Promise<SavedSubmit | null> {
  try {
    const raw = (await withStore('readonly', (s) => s.get(SUBMIT_KEY))) as SavedSubmit | LegacySavedSubmit | undefined
    if (raw == null) return null
    if ('version' in raw && raw.version === 2) return raw
    return migrateLegacySubmit(raw as LegacySavedSubmit)
  } catch {
    return null
  }
}

// Unlike the prepare run, submit state is NOT best-effort: losing it after a
// commit submitted means a reload could re-sign and double-submit. The driver
// awaits these writes at every transition and treats a failure as a stop.
export async function saveSubmit(submit: SavedSubmit): Promise<void> {
  await withStore('readwrite', (s) => s.put(submit, SUBMIT_KEY))
}

export async function clearSubmit(): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(SUBMIT_KEY))
  } catch {
    // best-effort
  }
}
