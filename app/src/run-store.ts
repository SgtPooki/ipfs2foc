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
  gateway: string
  relayBase: string
  /** Completed pieces keyed by the CID string as the user entered it. */
  results: Record<string, PieceResult>
  updatedAt: string
}

/**
 * One storage context's submit progress. Everything needed to resume after a
 * reload WITHOUT re-signing or re-submitting:
 * - `extraData` is the presigned authorization — the provider's pull endpoint
 *   is idempotent keyed on it, so re-pulling with the same blob is safe;
 *   presigning again would mint a different blob and a duplicate request.
 * - `txHash` (+ `signedDataSetId` when the presign targeted an existing data
 *   set) is recorded the moment commit submits; a resumed run polls the
 *   provider's status URL reconstructed from these instead of ever re-posting
 *   commit.
 * All bigints are stored as strings so the record survives JSON round-trips.
 */
export interface SavedSubmitContext {
  role: 'primary' | 'secondary'
  providerId: string
  providerName: string
  serviceURL: string
  extraData?: `0x${string}`
  /**
   * Data set the presign targeted: present means the extraData is an
   * AddPieces blob for that set, absent means create-and-add. A resumed
   * context whose resolved data set differs must discard the extraData (and
   * may, because nothing was submitted yet once txHash is absent).
   */
  signedDataSetId?: string
  pullComplete?: boolean
  txHash?: `0x${string}`
  /** Set once the commit confirmed on chain. */
  dataSetId?: string
  pieceIds?: string[]
  error?: string
}

export interface SavedSubmit {
  /** Wallet + network the run was signed under — a different pair must not resume it. */
  root: `0x${string}`
  chainId: number
  copies: number
  /** PieceCIDs covered by every presign in this run, sorted. */
  pieceCids: string[]
  contexts: SavedSubmitContext[]
  updatedAt: string
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
    return ((await withStore('readonly', (s) => s.get(SUBMIT_KEY))) as SavedSubmit | undefined) ?? null
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
