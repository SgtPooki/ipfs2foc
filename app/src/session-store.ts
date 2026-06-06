// Encrypted IndexedDB persistence for the session signing key (#23).
//
// The session private key must survive reload so long migrations resume
// without a fresh wallet grant. At rest it is AES-GCM-encrypted under a
// CryptoKey generated with `extractable: false` and stored as a key handle —
// same-origin script cannot export the AES bytes, so the wrap stops casual
// JS exfiltration of storage dumps. It is NOT a defense against offline
// forensics: a copied browser profile contains the key material inside the
// IDB files (structured clone stores it; non-extractable only gates the JS
// export API). The actual security boundary is the on-chain authorization —
// minimal permission scope, expiry, and revoke (see session.ts).
//
// Records are bound to (chainId, root wallet, session address): the tuple is
// the record key AND the AES-GCM additional authenticated data, so a record
// moved between accounts/networks fails authentication instead of decrypting.
// Separate database from the prepare-run store so key lifecycle never couples
// to run-state clears. Best-effort like run-store.ts: private windows and
// storage-denied contexts degrade to non-persistent sessions, never to a
// user-visible error.
import type { Hex } from 'viem'

const DB_NAME = 'ipfs2foc-session'
const STORE = 'session-key'

interface SessionRecord {
  sessionAddress: `0x${string}`
  aesKey: CryptoKey
  iv: Uint8Array<ArrayBuffer>
  ciphertext: ArrayBuffer
  /** Unix seconds, display/cache only — chain reads are authoritative. */
  expiresAt: string
  createdAt: string
}

export interface StoredSession {
  privateKey: Hex
  sessionAddress: `0x${string}`
  /** Unix seconds from the last grant/extend — verify on chain before use. */
  expiresAt: bigint
}

const recordKey = (chainId: number, root: string): string => `${chainId}:${root.toLowerCase()}`

const aad = (chainId: number, root: string, sessionAddress: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`${chainId}|${root.toLowerCase()}|${sessionAddress.toLowerCase()}`) as Uint8Array<ArrayBuffer>

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

export async function saveSessionKey(opts: {
  root: `0x${string}`
  chainId: number
  privateKey: Hex
  sessionAddress: `0x${string}`
  expiresAt: bigint
}): Promise<void> {
  try {
    const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(opts.chainId, opts.root, opts.sessionAddress) },
      aesKey,
      new TextEncoder().encode(opts.privateKey)
    )
    const record: SessionRecord = {
      sessionAddress: opts.sessionAddress,
      aesKey,
      iv,
      ciphertext,
      expiresAt: opts.expiresAt.toString(),
      createdAt: new Date().toISOString(),
    }
    await withStore('readwrite', (s) => s.put(record, recordKey(opts.chainId, opts.root)))
  } catch {
    // best-effort: storage denied or private window — session lives in memory only
  }
}

/**
 * Load and decrypt the stored session key for this wallet+network. Returns
 * null when absent, when storage is unavailable, or when authentication
 * fails (record moved across accounts/networks, or corrupted).
 */
export async function loadSessionKey(opts: { root: `0x${string}`; chainId: number }): Promise<StoredSession | null> {
  try {
    const record = (await withStore('readonly', (s) => s.get(recordKey(opts.chainId, opts.root)))) as
      | SessionRecord
      | undefined
    if (record == null) return null
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: aad(opts.chainId, opts.root, record.sessionAddress) },
      record.aesKey,
      record.ciphertext
    )
    return {
      privateKey: new TextDecoder().decode(plain) as Hex,
      sessionAddress: record.sessionAddress,
      expiresAt: BigInt(record.expiresAt),
    }
  } catch {
    return null
  }
}

/** Update the cached expiry after an extend-in-place re-grant. */
export async function updateSessionExpiry(opts: {
  root: `0x${string}`
  chainId: number
  expiresAt: bigint
}): Promise<void> {
  try {
    const key = recordKey(opts.chainId, opts.root)
    const record = (await withStore('readonly', (s) => s.get(key))) as SessionRecord | undefined
    if (record == null) return
    record.expiresAt = opts.expiresAt.toString()
    await withStore('readwrite', (s) => s.put(record, key))
  } catch {
    // best-effort
  }
}

export async function wipeSessionKey(opts: { root: `0x${string}`; chainId: number }): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(recordKey(opts.chainId, opts.root)))
  } catch {
    // best-effort
  }
}
