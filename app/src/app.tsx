import type { Capabilities } from 'ipfs2foc-core/capabilities'
import { explorerDataSetUrl, explorerPieceUrl } from 'ipfs2foc-core/pdp-verifier'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_RELAY } from './capabilities.ts'
import { type CidIntake, parseCidFile } from './cid-file.ts'
import { computePiece, describePrepareFailure, type PieceResult } from './commp.ts'
import { HASH_POOL_SIZE } from './hash-pool.ts'
import { buildManifest, downloadManifest } from './manifest.ts'
import { fmtToken, type PaymentsStatus, RPC_URLS, readPaymentsStatus, readyToSign } from './payments.ts'
import { clearRun, clearSubmit, loadRun, loadSubmit, type SavedSubmit, saveRun, saveSubmit } from './run-store.ts'
import {
  DEFAULT_SESSION_DURATION_SECONDS,
  extendSession,
  grantSession,
  resumeSession,
  revokeSession,
  SESSION_DURATIONS,
  type SessionState,
  sessionCanPresign,
} from './session.ts'
import {
  findResumableSubmit,
  requeueDeferred,
  runSubmit,
  SubmitBlockedError,
  type SubmitContextStatus,
  type SubmitState,
  submitStateFromSaved,
} from './submit.ts'
import { useTabLifetime } from './tab-guard.ts'
import { type VerifyResult, verifyDataSet } from './verify.ts'
import { connectWallet, NETWORKS, networkOf, refreshWallet, switchToCalibration, type WalletState } from './wallet.ts'

const DEFAULT_GATEWAY = 'https://trustless-gateway.link'
// The hosted signing flow is calibration-only for now: session/submit take a
// network parameter already, but wallet switching knows only calibration.
// Generalizing to capabilities.network lands with the local signing flow.
const TARGET_NETWORK = 'calibration' as const

type RowState =
  | { phase: 'queued' }
  | { phase: 'working'; bytes: number; rate: number }
  | { phase: 'done'; result: PieceResult }
  | { phase: 'error'; message: string; detail: string }

// Process several CIDs at once. Retrieval (one streaming CAR request per root)
// and CAR assembly run on this thread; the CPU-bound hashing runs in pooled
// workers, one core per concurrent piece.
const CONCURRENCY = HASH_POOL_SIZE
// Don't re-render on every stream chunk — that starves the thread doing the
// hashing. Emit progress at most this often.
const PROGRESS_THROTTLE_MS = 250
// A working row that has not advanced its byte counter for this long is
// stalled and gets aborted with a retryable error (#43). A healthy stream
// ticks continuously; even a cold gateway warming a block through retries
// produces a byte well inside this window. The CLI's provider-pull watchdog
// (PULL_STALL_TIMEOUT_MS, 15 min) guards whole-piece pulls; this guards a
// per-chunk stream, so it can be much tighter.
const STALL_TIMEOUT_MS = 120_000
const STALL_POLL_MS = 5_000

interface Row {
  cid: string
  state: RowState
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(2)} ${units[i]}`
}

function short(s: string, head = 10, tail = 6): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`
}

function fmtExpiry(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function Led({ on, color }: { on: boolean; color: string }) {
  return <span className="led" style={{ background: on ? color : 'transparent', borderColor: color }} />
}

function describeSubmitPhase(c: SubmitContextStatus): string {
  // Large runs land in several chunks (one provider add each); show which
  // one is in flight so a long submit reads as progress, not repetition.
  const chunk = c.chunkIndex != null && c.chunks.length > 1 ? `chunk ${c.chunkIndex + 1}/${c.chunks.length} · ` : ''
  switch (c.phase) {
    case 'queued':
      return 'queued'
    case 'presigning':
      return `${chunk}signing authorization…`
    case 'pulling': {
      const statuses = c.pullStatus ? Object.values(c.pullStatus) : []
      const done = statuses.filter((s) => s === 'complete').length
      return `${chunk}provider pulling ${done}/${statuses.length}…`
    }
    case 'committing':
      return `${chunk}committing on-chain…`
    case 'confirming':
      return `${chunk}confirming…`
    case 'done':
      return 'committed ✓'
    case 'failed':
      return c.error ?? 'failed'
  }
}

export default function App({ caps }: { caps: Capabilities }) {
  const [wallet, setWallet] = useState<WalletState | null>(null)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [payments, setPayments] = useState<PaymentsStatus | null>(null)
  const [paymentsError, setPaymentsError] = useState<string | null>(null)
  const [paymentsLoading, setPaymentsLoading] = useState(false)
  const [session, setSession] = useState<SessionState | null>(null)
  const [sessionBusy, setSessionBusy] = useState<string | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [sessionDuration, setSessionDuration] = useState<bigint>(DEFAULT_SESSION_DURATION_SECONDS)
  const [cidsText, setCidsText] = useState('')
  // CIDs loaded from a cids.txt file (#50). Kept out of the textarea: an
  // inventory file can run to tens of thousands of lines, more than a
  // textarea (or a person) should hold. Joined with the pasted list in
  // `cids` below.
  const [cidFile, setCidFile] = useState<{ name: string; intake: CidIntake } | null>(null)
  const [cidFileBusy, setCidFileBusy] = useState(false)
  const [cidFileError, setCidFileError] = useState<string | null>(null)
  const [relayBase, setRelayBase] = useState(caps.pieceBase ?? DEFAULT_RELAY)
  const [gateway, setGateway] = useState(DEFAULT_GATEWAY)
  const [rows, setRows] = useState<Row[]>([])
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [copies, setCopies] = useState(2)
  const [submitState, setSubmitState] = useState<SubmitState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitBlocked, setSubmitBlocked] = useState<SubmitBlockedError['reason'] | null>(null)
  // PieceCIDs the provider refused as too small — drives the recovery offers
  // (submit the rest now, download a manifest of just the remainder).
  const [tooSmallCids, setTooSmallCids] = useState<string[] | null>(null)
  const [resumable, setResumable] = useState<SavedSubmit | null>(null)
  // Completed pieces by input CID — the write-through copy of what run-store
  // persists, and the source for skip-on-resume in run().
  const savedResults = useRef<Record<string, PieceResult>>({})
  const [restored, setRestored] = useState(false)
  // Writes are blocked until the restore attempt settles, so an early debounced
  // persist of the empty textarea cannot clobber a saved run.
  const hydrated = useRef(false)
  // True once any prepare run has started this page-load. The async restore
  // below races a run started before it resolves: replacing rows and
  // savedResults with the saved (older) snapshot re-marked finished rows as
  // queued and made the pool look like it died mid-run (#42).
  const ranRef = useRef(false)

  // Restore the previous run once on load (#26). Done rows come back as done;
  // anything else shows queued and recomputes on the next prepare.
  useEffect(() => {
    loadRun().then((saved) => {
      hydrated.current = true
      if (saved == null) return
      // Merge, never replace: a run that started before this restore resolved
      // has fresher results than the snapshot read from storage (#42).
      for (const [cid, result] of Object.entries(saved.results)) {
        savedResults.current[cid] ??= result
      }
      // A live (or finished) run owns the input and the rows — restoring the
      // saved snapshot over them would clobber its progress (#42).
      if (ranRef.current) return
      setCidsText(saved.cidsText)
      setRelayBase(saved.relayBase)
      setGateway(saved.gateway)
      if (saved.fileCids != null && saved.fileCids.length > 0) {
        setCidFile({
          name: saved.fileName ?? 'cids.txt',
          intake: { cids: saved.fileCids, invalidSamples: [], invalidCount: saved.fileInvalidCount ?? 0 },
        })
      }
      const savedCids = Array.from(
        new Set(
          saved.cidsText
            .split(/\s+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .concat(saved.fileCids ?? [])
        )
      )
      const doneCount = savedCids.filter((cid) => savedResults.current[cid] != null).length
      if (doneCount > 0) {
        setRows(
          savedCids.map((cid) => {
            const result = savedResults.current[cid]
            return { cid, state: result ? { phase: 'done', result } : { phase: 'queued' } }
          })
        )
        setRestored(true)
      }
    })
  }, [])

  const persist = useCallback(
    (text: string) => {
      if (!hydrated.current) return
      void saveRun({
        cidsText: text,
        fileName: cidFile?.name,
        fileCids: cidFile?.intake.cids,
        fileInvalidCount: cidFile?.intake.invalidCount,
        gateway,
        relayBase,
        results: savedResults.current,
        updatedAt: new Date().toISOString(),
      })
    },
    [gateway, relayBase, cidFile]
  )

  // Persist input edits (debounced) so a refresh keeps the CID list and source
  // settings even before a run starts.
  useEffect(() => {
    const t = setTimeout(() => persist(cidsText), 500)
    return () => clearTimeout(t)
  }, [cidsText, persist])

  const cids = useMemo(
    () =>
      Array.from(
        new Set(
          cidsText
            .split(/\s+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .concat(cidFile?.intake.cids ?? [])
        )
      ),
    [cidsText, cidFile]
  )

  const results = useMemo(() => rows.flatMap((r) => (r.state.phase === 'done' ? [r.state.result] : [])), [rows])
  const errors = rows.filter((r) => r.state.phase === 'error').length
  const walletNetwork = wallet == null ? null : networkOf(wallet.chainId)
  const onCalibration = walletNetwork === TARGET_NETWORK
  const allCommitted =
    submitState != null && submitState.contexts.length > 0 && submitState.contexts.every((c) => c.phase === 'done')

  // Long runs: keep the screen awake and confirm accidental closes while
  // prepare or submit is in flight. Closing stays safe — both resume.
  useTabLifetime(running || submitting)

  // Payment-readiness reads (#23 signing prerequisites). Public-RPC reads on
  // the connected address — nothing is signed; re-read whenever the wallet or
  // its network changes.
  useEffect(() => {
    setPayments(null)
    setPaymentsError(null)
    setPaymentsLoading(false)
    if (wallet == null) return
    const network = networkOf(wallet.chainId)
    if (network == null) return
    let stale = false
    setPaymentsLoading(true)
    readPaymentsStatus(wallet.address, network)
      .then((s) => {
        if (!stale) setPayments(s)
      })
      .catch((err) => {
        if (!stale) setPaymentsError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!stale) setPaymentsLoading(false)
      })
    return () => {
      stale = true
    }
  }, [wallet])

  // Restore a stored signing session for this wallet+network (#23). Chain
  // reads are authoritative: resumeSession validates both granted permissions
  // and wipes a dead record itself.
  useEffect(() => {
    setSession(null)
    setSessionError(null)
    if (wallet == null) return
    const network = networkOf(wallet.chainId)
    if (network !== TARGET_NETWORK) return
    let stale = false
    resumeSession(wallet, network)
      .then((s) => {
        if (!stale && s != null) setSession(s)
      })
      .catch(() => {
        // a failed resume is just "no session" — the grant flow stays offered
      })
    return () => {
      stale = true
    }
  }, [wallet])

  // Without a wallet the saved submit still renders read-only so verify-on-chain
  // (an account-less RPC read) can answer "is everything on FOC?" — the resume
  // path stays wallet-bound; this only surfaces the record.
  useEffect(() => {
    if (wallet != null) return
    let stale = false
    loadSubmit().then((saved) => {
      if (!stale && saved != null) setSubmitState((current) => current ?? submitStateFromSaved(saved))
    })
    return () => {
      stale = true
    }
  }, [wallet])

  // A previous submit run for exactly this wallet+network+piece set resumes
  // instead of restarting — its presigns and any submitted commits are bound
  // to all three. Shown read-only until the operator presses Submit again.
  useEffect(() => {
    setResumable(null)
    if (wallet == null || results.length === 0 || !onCalibration) return
    let stale = false
    findResumableSubmit(wallet, TARGET_NETWORK, results).then((saved) => {
      if (stale || saved == null) return
      setResumable(saved)
      setCopies(saved.copies)
      setSubmitState((current) => current ?? submitStateFromSaved(saved))
    })
    return () => {
      stale = true
    }
  }, [wallet, onCalibration, results])

  const submitWith = useCallback(
    async (excludePieceCids: string[] | null, ignoreMinPieceSize = false) => {
      if (wallet == null || session == null || results.length === 0) return
      const pieces = excludePieceCids == null ? results : results.filter((r) => !excludePieceCids.includes(r.pieceCid))
      if (pieces.length === 0) return
      setSubmitError(null)
      setSubmitBlocked(null)
      setSubmitting(true)
      try {
        const prior = await findResumableSubmit(wallet, TARGET_NETWORK, pieces)
        const finished = await runSubmit({
          wallet,
          network: TARGET_NETWORK,
          session,
          pieces,
          copies: prior?.copies ?? copies,
          prior,
          ignoreMinPieceSize,
          onUpdate: setSubmitState,
        })
        setResumable(await findResumableSubmit(wallet, TARGET_NETWORK, pieces))
        return finished
      } catch (err) {
        if (err instanceof SubmitBlockedError) {
          setSubmitBlocked(err.reason)
          if (err.reason === 'piece-too-small') setTooSmallCids(err.pieceCids ?? null)
        }
        setSubmitError(err instanceof Error ? err.message : String(err))
      } finally {
        setSubmitting(false)
      }
    },
    [wallet, session, results, copies]
  )

  // The advertised min-piece floor is not enforced by default: no enforcement
  // has been found in the provider's pull path, so the provider is the judge
  // and a real refusal shows in the per-piece pull status. The pre-check
  // remains available for callers that want the strict behavior.
  const submit = useCallback(() => void submitWith(null, true), [submitWith])
  const submitEligible = useCallback(() => void submitWith(tooSmallCids), [submitWith, tooSmallCids])
  const submitAllAnyway = useCallback(() => void submitWith(null, true), [submitWith])

  const discardSubmit = useCallback(() => {
    void clearSubmit()
    setResumable(null)
    setSubmitState(null)
    setSubmitError(null)
    setSubmitBlocked(null)
    setTooSmallCids(null)
  }, [])

  const extend = useCallback(async () => {
    if (wallet == null || session == null) return
    setSessionError(null)
    setSessionBusy('extending…')
    try {
      const s = await extendSession(wallet, TARGET_NETWORK, session, DEFAULT_SESSION_DURATION_SECONDS, () =>
        setSessionBusy('confirming…')
      )
      setSession(s)
      setSubmitBlocked((b) => (b === 'session-margin' ? null : b))
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionBusy(null)
    }
  }, [wallet, session])

  const grant = useCallback(async () => {
    if (wallet == null) return
    setSessionError(null)
    setSessionBusy('authorizing…')
    try {
      const s = await grantSession(wallet, TARGET_NETWORK, sessionDuration, () => setSessionBusy('confirming…'))
      setSession(s)
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionBusy(null)
    }
  }, [wallet, sessionDuration])

  const revoke = useCallback(async () => {
    if (wallet == null || session == null) return
    setSessionError(null)
    setSessionBusy('revoking…')
    try {
      await revokeSession(wallet, TARGET_NETWORK, session, () => setSessionBusy('confirming revoke…'))
      setSession(null)
    } catch (err) {
      // Chain-first revoke failed — the key stays usable and revocable.
      setSessionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionBusy(null)
    }
  }, [wallet, session])

  const connect = useCallback(async () => {
    setWalletError(null)
    try {
      setWallet(await connectWallet())
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const switchNet = useCallback(async () => {
    setWalletError(null)
    try {
      await switchToCalibration()
      setWallet(await refreshWallet())
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // Live AbortControllers by CID — the stall watchdog and the per-row cancel
  // button abort through these (#43).
  const prepareControllers = useRef(new Map<string, AbortController>())

  // Compute one CID's piece and patch its row through the phases. Shared by
  // the Prepare worker pool and the per-row Retry action (#34).
  const prepareOne = useCallback(
    async (cid: string) => {
      const startedAt = performance.now()
      let lastEmit = 0
      const patch = (state: RowState) => setRows((prev) => prev.map((r) => (r.cid === cid ? { ...r, state } : r)))
      patch({ phase: 'working', bytes: 0, rate: 0 })
      const controller = new AbortController()
      prepareControllers.current.set(cid, controller)
      // Every progress callback means the byte counter advanced (the exporter
      // reports cumulative size per chunk). No advance for the stall window →
      // abort with a retryable error and free the worker slot.
      let lastAdvanceAt = performance.now()
      const watchdog = setInterval(() => {
        if (performance.now() - lastAdvanceAt > STALL_TIMEOUT_MS) {
          controller.abort(
            new Error(
              `the source stopped sending bytes (${Math.round(STALL_TIMEOUT_MS / 1000)}s without progress) — ` +
                'the network is not serving this CID right now; retry later or check availability'
            )
          )
        }
      }, STALL_POLL_MS)
      try {
        const result = await computePiece(
          gateway,
          cid,
          relayBase,
          (bytes) => {
            const now = performance.now()
            lastAdvanceAt = now
            if (now - lastEmit < PROGRESS_THROTTLE_MS) return
            lastEmit = now
            const secs = (now - startedAt) / 1000
            patch({ phase: 'working', bytes, rate: secs > 0 ? bytes / 1048576 / secs : 0 })
          },
          controller.signal
        )
        patch({ phase: 'done', result })
        savedResults.current[cid] = result
        persist(cidsText)
      } catch (err) {
        const failure = describePrepareFailure(err)
        patch({ phase: 'error', message: failure.headline, detail: failure.detail })
      } finally {
        clearInterval(watchdog)
        prepareControllers.current.delete(cid)
      }
    },
    [cidsText, gateway, relayBase, persist]
  )

  const cancelOne = useCallback((cid: string) => {
    prepareControllers.current.get(cid)?.abort(new Error('cancelled — retry whenever'))
  }, [])

  const run = useCallback(async () => {
    ranRef.current = true
    setRunning(true)
    // Prune saved results for CIDs no longer in the input, then seed done rows
    // from the saved run — pieces are deterministic, so a saved result is final
    // and only the pending/failed CIDs go back through a worker.
    const inputSet = new Set(cids)
    savedResults.current = Object.fromEntries(Object.entries(savedResults.current).filter(([cid]) => inputSet.has(cid)))
    setRows(
      cids.map((cid) => {
        const result = savedResults.current[cid]
        return { cid, state: result ? { phase: 'done', result } : { phase: 'queued' } }
      })
    )
    persist(cidsText)

    // Worker pool over the CIDs that still need computing.
    const pending = cids.filter((cid) => savedResults.current[cid] == null)
    let next = 0
    const worker = async () => {
      while (next < pending.length) {
        await prepareOne(pending[next++])
      }
    }
    // prepareOne resolves on every path (its catch maps failures to row state),
    // but `running` must never stick at true: the finally keeps the button
    // honest even if a future edit lets a worker reject.
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker))
    } finally {
      setRunning(false)
    }
  }, [cids, cidsText, persist, prepareOne])

  // Parse a picked or dropped cids.txt. Streaming, so the only state the tab
  // holds afterward is the accepted list and the reject summary.
  const loadCidFile = useCallback(async (file: File) => {
    setCidFileError(null)
    setCidFileBusy(true)
    try {
      const intake = await parseCidFile(file)
      if (intake.cids.length === 0) {
        setCidFile(null)
        setCidFileError(
          intake.invalidCount > 0
            ? `no valid CIDs in ${file.name} — ${intake.invalidCount} line(s) rejected (line ${intake.invalidSamples[0].line}: "${intake.invalidSamples[0].text}")`
            : `no CIDs in ${file.name}`
        )
        return
      }
      setCidFile({ name: file.name, intake })
    } catch (err) {
      setCidFile(null)
      setCidFileError(`could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCidFileBusy(false)
    }
  }, [])

  const clearCidFile = useCallback(() => {
    setCidFile(null)
    setCidFileError(null)
  }, [])

  const reset = useCallback(() => {
    savedResults.current = {}
    setRows([])
    setCidsText('')
    setCidFile(null)
    setCidFileError(null)
    setRestored(false)
    setSubmitState(null)
    setResumable(null)
    setSubmitError(null)
    setSubmitBlocked(null)
    void clearRun()
    void clearSubmit()
  }, [])

  const copy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200)
    })
  }, [])

  const saveManifest = useCallback(() => {
    downloadManifest(
      buildManifest(results, {
        tool: 'ipfs2foc-app',
        network: TARGET_NETWORK,
        relayBase,
        gateway,
        now: new Date().toISOString(),
      })
    )
  }, [results, relayBase, gateway])

  // Manifest of only the items a provider refused as too small — the exact
  // input the local packing path needs, without re-submitting what already
  // committed here.
  const saveRemainderManifest = useCallback(() => {
    if (tooSmallCids == null) return
    const small = results.filter((r) => tooSmallCids.includes(r.pieceCid))
    downloadManifest(
      buildManifest(small, {
        tool: 'ipfs2foc-app',
        network: TARGET_NETWORK,
        relayBase,
        gateway,
        now: new Date().toISOString(),
      })
    )
  }, [tooSmallCids, results, relayBase, gateway])

  // Pieces no provider could fetch this run (deduped across copies) — the
  // committable rest already landed; these get a retry and a remainder.
  const deferredCids = useMemo(
    () => [...new Set((submitState?.contexts ?? []).flatMap((c) => c.deferredPieceCids ?? []))],
    [submitState]
  )

  const saveDeferredManifest = useCallback(() => {
    const set = new Set(deferredCids)
    downloadManifest(
      buildManifest(
        results.filter((r) => set.has(r.pieceCid)),
        { tool: 'ipfs2foc-app', network: TARGET_NETWORK, relayBase, gateway, now: new Date().toISOString() }
      )
    )
  }, [deferredCids, results, relayBase, gateway])

  const retryDeferred = useCallback(async () => {
    if (wallet == null) return
    const saved = await findResumableSubmit(wallet, TARGET_NETWORK, results)
    if (saved == null) return
    setResumable(await requeueDeferred(saved))
    // Same advisory-floor stance as the regular Submit — the deferred pieces
    // are small ones by definition, so the strict pre-check would just block.
    void submitWith(null, true)
  }, [wallet, results, submitWith])

  // Verify-on-chain (#47): account-less reads of the data set's active pieces
  // and proving status, keyed per provider context. The chain is the only
  // signal that may flip a piece's state here — never a gateway probe.
  const [verifying, setVerifying] = useState<string | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [verifyReports, setVerifyReports] = useState<
    Record<string, { result: VerifyResult; network: 'mainnet' | 'calibration'; dataSetId: string; cleared: number }>
  >({})

  const verifyContext = useCallback(async (providerId: string) => {
    setVerifyError(null)
    setVerifying(providerId)
    try {
      // The saved record (not React state) is the source of truth: it carries
      // the chain id, every chunk's pieces, and the deferred set.
      const saved = await loadSubmit()
      const c = saved?.contexts.find((x) => x.providerId === providerId)
      if (saved == null || c?.dataSetId == null) throw new Error('no saved run with a data set for this provider')
      const network = networkOf(saved.chainId)
      if (network == null) throw new Error(`saved run is on an unknown chain (id ${saved.chainId})`)
      const prepared = [...new Set([...c.chunks.flatMap((ch) => ch.pieceCids), ...(c.deferredPieceCids ?? [])])]
      const txHashes = c.chunks.flatMap((ch) => (ch.txHash == null ? [] : [ch.txHash]))
      const result = await verifyDataSet({
        rpcUrl: RPC_URLS[network],
        network,
        dataSetId: Number(c.dataSetId),
        preparedPieceCids: prepared,
        txHashes,
      })
      // A deferred piece the chain holds was committed on another surface
      // (or a forgotten retry landed) — record it as a committed chunk so the
      // skipped banner clears and resume never re-queues it.
      const settled = (c.deferredPieceCids ?? []).filter((p) => result.found.has(p))
      if (settled.length > 0) {
        const remaining = (c.deferredPieceCids ?? []).filter((p) => !result.found.has(p))
        c.deferredPieceCids = remaining.length > 0 ? remaining : undefined
        c.chunks.push({ pieceCids: settled, pullComplete: true, committed: true })
        saved.updatedAt = new Date().toISOString()
        await saveSubmit(saved)
        setSubmitState(submitStateFromSaved(saved))
        setResumable((prev) => (prev == null ? prev : saved))
      }
      setVerifyReports((prev) => ({
        ...prev,
        [providerId]: { result, network, dataSetId: c.dataSetId as string, cleared: settled.length },
      }))
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err))
    } finally {
      setVerifying(null)
    }
  }, [])

  const eligibleCount = tooSmallCids == null ? 0 : results.filter((r) => !tooSmallCids.includes(r.pieceCid)).length
  const queuedCount = rows.filter((r) => r.state.phase === 'queued').length
  // Raw CARs at or under 127/128 × 512 KiB pad below the 1 MiB floor most
  // providers advertise. Informational only — submission proceeds regardless.
  const underTypicalFloor = results.filter((r) => r.rawSize <= 520_192).length

  return (
    <div className="shell">
      <div aria-hidden className="grid-overlay" />
      <header className="masthead">
        <div className="brand">
          <span className="mark">ipfs2foc</span>
          <span className="sub">browser migration console</span>
        </div>
        <div className="net-badge">
          <Led color="var(--accent)" on />
          <span>calibration · testnet</span>
        </div>
      </header>

      <p className="lede">
        Compute Filecoin piece commitments for your pinned IPFS CIDs <em>in this tab</em> — the CAR bytes stream through
        the hasher and never leave your browser — then export the pull URLs a storage provider follows through the
        redirect relay. No re-chunking. No server.
      </p>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-no">01</span>
          <h2>Wallet</h2>
          <span className="panel-note">read-only in this step — nothing is signed yet</span>
        </div>
        <div className="wallet-row">
          {wallet == null ? (
            <button className="btn primary" onClick={connect} type="button">
              Connect wallet
            </button>
          ) : (
            <div className="wallet-on">
              <Led color={onCalibration ? 'var(--ok)' : 'var(--warn)'} on />
              <code className="addr">{short(wallet.address, 8, 6)}</code>
              <span className={`chip ${onCalibration ? 'chip-ok' : 'chip-warn'}`}>
                {walletNetwork ? NETWORKS[walletNetwork].label : `chain ${wallet.chainId}`}
              </span>
              {!onCalibration && (
                <>
                  <button className="btn small" onClick={switchNet} type="button">
                    Switch to Calibration
                  </button>
                  <span className="hint">optional now — the prepare step below works on any network</span>
                </>
              )}
            </div>
          )}
          {walletError && <span className="err-text">{walletError}</span>}
        </div>
        {wallet != null && walletNetwork != null && (
          <div className="pay-status">
            {paymentsLoading ? (
              <span className="dim">reading payment status…</span>
            ) : paymentsError == null ? (
              payments == null ? null : (
                <>
                  <span className="pay-label">wallet</span>
                  <span className="pay-value">
                    {fmtToken(payments.fil, walletNetwork === 'calibration' ? 'tFIL' : 'FIL')} ·{' '}
                    {fmtToken(payments.walletUsdfc, 'USDFC')}
                  </span>
                  <span className="pay-label">deposited</span>
                  <span className="pay-value">
                    {fmtToken(payments.depositedUsdfc, 'USDFC')} ({fmtToken(payments.availableUsdfc, 'USDFC')}{' '}
                    available)
                  </span>
                  <span className="pay-label">storage operator</span>
                  <span className="pay-value">
                    <Led color={payments.operatorApproved ? 'var(--ok)' : 'var(--warn)'} on />{' '}
                    {payments.operatorApproved ? 'approved' : 'not approved'}
                  </span>
                  {!readyToSign(payments) && (
                    <span className="pay-setup">
                      signing needs a one-time payment setup: deposit USDFC into Filecoin Pay and approve the storage
                      service as a payments operator —{' '}
                      <a
                        href="https://github.com/SgtPooki/ipfs2foc#network-gas-and-payments"
                        rel="noreferrer"
                        target="_blank"
                      >
                        setup guide
                      </a>
                    </span>
                  )}
                  {readyToSign(payments) && onCalibration && (
                    <>
                      <span className="pay-label">signing session</span>
                      {session == null ? (
                        <span className="pay-value session-controls">
                          <select
                            disabled={sessionBusy != null}
                            onChange={(e) => setSessionDuration(BigInt(e.target.value))}
                            value={sessionDuration.toString()}
                          >
                            {SESSION_DURATIONS.map((d) => (
                              <option key={d.label} value={d.seconds.toString()}>
                                {d.label}
                              </option>
                            ))}
                          </select>
                          <button className="btn small" disabled={sessionBusy != null} onClick={grant} type="button">
                            {sessionBusy ?? 'Enable signing'}
                          </button>
                        </span>
                      ) : (
                        <span className="pay-value session-controls">
                          <Led color={sessionCanPresign(session) ? 'var(--ok)' : 'var(--warn)'} on />
                          <span>
                            until {fmtExpiry(session.expiresAt)} · <code>{short(session.sessionAddress, 6, 4)}</code>
                          </span>
                          <button className="btn small" disabled={sessionBusy != null} onClick={extend} type="button">
                            Extend +24h
                          </button>
                          <button className="btn small" disabled={sessionBusy != null} onClick={revoke} type="button">
                            Revoke
                          </button>
                          {sessionBusy != null && <span className="dim">{sessionBusy}</span>}
                        </span>
                      )}
                      {session == null ? (
                        <span className="pay-setup">
                          one wallet approval authorizes a temporary key to sign migration steps for the chosen window.
                          it can create data sets and add pieces — spending from the{' '}
                          {fmtToken(payments.availableUsdfc, 'USDFC')} available — and nothing else: no removals, no
                          deletions, no withdrawals. revoke it here when the run is done.
                          {sessionDuration > 86_400n &&
                            ' long windows leave the key authorized on this device for days — prefer shorter unless the run needs it.'}
                        </span>
                      ) : sessionCanPresign(session) ? null : (
                        <span className="pay-setup">
                          session expires soon — new submissions pause within an hour of expiry so providers can land
                          in-flight pieces. extend it to continue.
                        </span>
                      )}
                    </>
                  )}
                </>
              )
            ) : (
              <span className="err-text" title={paymentsError}>
                payment status unavailable: {short(paymentsError, 48, 0)}
              </span>
            )}
            {sessionError != null && (
              <span className="err-text" title={sessionError}>
                session: {short(sessionError, 64, 0)}
              </span>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-no">02</span>
          <h2>CIDs</h2>
          <span className="panel-note">{cids.length} unique</span>
        </div>
        <textarea
          className="cid-input"
          onChange={(e) => setCidsText(e.target.value)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const file = e.dataTransfer.files[0]
            if (file == null) return
            e.preventDefault()
            void loadCidFile(file)
          }}
          placeholder={'bafybei…\nQm…  (CIDv0 or CIDv1, one per line)\nor drop a cids.txt here'}
          spellCheck={false}
          value={cidsText}
        />
        <div className="file-intake">
          <label className="btn small">
            {cidFileBusy ? 'Reading…' : 'Load cids.txt'}
            <input
              accept=".txt,.csv,text/plain"
              disabled={cidFileBusy || running}
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file != null) void loadCidFile(file)
              }}
              type="file"
            />
          </label>
          {cidFile != null && (
            <>
              <span className="panel-note">
                {cidFile.intake.cids.length.toLocaleString()} CIDs from {cidFile.name}
                {cidFile.intake.invalidCount > 0 &&
                  ` · ${cidFile.intake.invalidCount.toLocaleString()} invalid line(s) skipped` +
                    (cidFile.intake.invalidSamples.length > 0
                      ? ` (first: line ${cidFile.intake.invalidSamples[0].line} "${cidFile.intake.invalidSamples[0].text}")`
                      : '')}
              </span>
              <button className="btn small" disabled={running} onClick={clearCidFile} type="button">
                Remove file
              </button>
            </>
          )}
          {cidFileError != null && <span className="err-text">{cidFileError}</span>}
        </div>
        <details className="advanced">
          <summary>Sources</summary>
          <label className="field">
            <span>Gateway</span>
            <input onChange={(e) => setGateway(e.target.value)} spellCheck={false} value={gateway} />
          </label>
          <label className="field">
            <span>Redirect relay</span>
            <input onChange={(e) => setRelayBase(e.target.value)} spellCheck={false} value={relayBase} />
          </label>
        </details>
        <div className="actions">
          <button className="btn primary" disabled={running || cids.length === 0} onClick={run} type="button">
            {running ? 'Computing…' : `Prepare ${cids.length || ''} migration${cids.length === 1 ? '' : 's'}`.trim()}
          </button>
          {(cids.length > 0 || rows.length > 0) && (
            <button className="btn small" disabled={running} onClick={reset} type="button">
              Clear
            </button>
          )}
        </div>
      </section>

      {rows.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-no">03</span>
            <h2>Pieces</h2>
            <span className="panel-note">
              {results.length} ready{errors > 0 ? ` · ${errors} failed` : ''}
              {restored ? ' · restored from last session' : ''}
            </span>
          </div>
          <div className="table">
            <div className="trow thead">
              <span>CID</span>
              <span>PieceCID</span>
              <span className="num">Size</span>
              <span>Pull URL</span>
            </div>
            {rows.map((r) => {
              // Show the canonical CIDv1 once computed (a `Qm…` input is converted),
              // so the row reflects exactly what gets committed and relayed.
              const shownCid = r.state.phase === 'done' ? r.state.result.cid : r.cid
              return (
                <div className="trow" key={r.cid}>
                  <code className="mono dim" title={shownCid}>
                    {short(shownCid)}
                  </code>
                  {r.state.phase === 'done' ? (
                    <span className="piece">
                      <code className="mono" title={r.state.result.pieceCid}>
                        {short(r.state.result.pieceCid)}
                      </code>
                      {r.state.result.gapFillCount > 0 && (
                        <span
                          className="warn"
                          title={`Gateway served an incomplete CAR — ${r.state.result.gapFillCount} block(s) recovered per-block. The provider pulls the CAR URL, so re-verify this gateway before submitting; if its CAR is still incomplete at pull time the on-chain AddPieces will fail.`}
                        >
                          ⚠ incomplete CAR
                        </span>
                      )}
                    </span>
                  ) : r.state.phase === 'error' ? (
                    <span className="err-text" title={r.state.detail}>
                      {short(r.state.message, 44, 0)}{' '}
                      <a
                        href={`https://check.ipfs.network/?cid=${r.cid}`}
                        rel="noreferrer"
                        target="_blank"
                        title="probe this CID's providers and retrievability on the public network"
                      >
                        check availability
                      </a>
                    </span>
                  ) : r.state.phase === 'working' ? (
                    <span className="working">
                      ▍ {fmtBytes(r.state.bytes)}
                      {r.state.rate > 0 ? ` · ${r.state.rate.toFixed(1)} MiB/s` : ''}
                    </span>
                  ) : (
                    <span className="dim">queued</span>
                  )}
                  <span className="num mono dim">
                    {r.state.phase === 'done' ? fmtBytes(r.state.result.rawSize) : '—'}
                  </span>
                  {r.state.phase === 'done' ? (
                    <button
                      className="copy"
                      onClick={() => copy(r.state.phase === 'done' ? r.state.result.sourceUrl : '', r.cid)}
                      type="button"
                    >
                      {copied === r.cid ? 'copied ✓' : 'copy'}
                    </button>
                  ) : r.state.phase === 'error' ? (
                    <button className="copy" disabled={running} onClick={() => void prepareOne(r.cid)} type="button">
                      retry
                    </button>
                  ) : r.state.phase === 'working' ? (
                    <button className="copy" onClick={() => cancelOne(r.cid)} type="button">
                      cancel
                    </button>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </div>
              )
            })}
          </div>
          {errors > 0 && (
            <p className="gate-note">
              finished rows are kept — Prepare and per-row retry recompute only what failed. hover a failure for the
              full error; "check availability" shows whether the network can serve that CID at all.
            </p>
          )}
          {!running && queuedCount > 0 && rows.length > 0 && (
            <p className="gate-note">
              {queuedCount} item{queuedCount === 1 ? '' : 's'} not prepared yet — press Prepare to continue; it picks up
              exactly where the run stopped and never recomputes a finished row.
            </p>
          )}
          {running && (
            <p className="gate-note">
              reloading is safe at any point: finished rows are restored from this browser and Prepare resumes the rest.
              a row that stops receiving bytes for {Math.round(STALL_TIMEOUT_MS / 60000)} minutes fails on its own and
              frees the worker; cancel does the same immediately.
            </p>
          )}
          {results.length > 0 && (
            <div className="actions">
              <button className="btn" onClick={saveManifest} type="button">
                Download run manifest ({results.length})
              </button>
              <span className="panel-note">
                the portable record of this run — pull URLs and commitments for the submit step
              </span>
            </div>
          )}
        </section>
      )}

      {(results.length > 0 || submitState != null) && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-no">04</span>
            <h2>Submit</h2>
            <span className="panel-note">one on-chain commit per copy · signed by the session key, no prompts</span>
          </div>
          {results.length === 0 ? (
            <p className="gate-note">
              a previous run's submit state is shown below — verify it against the chain anytime, or paste the run's
              CIDs above to resume submitting.
            </p>
          ) : wallet == null || !onCalibration ? (
            <p className="gate-note">connect the wallet on Calibration above to submit.</p>
          ) : payments == null || !readyToSign(payments) ? (
            <p className="gate-note">finish the one-time payment setup above to submit.</p>
          ) : session == null ? (
            <p className="gate-note">enable signing above to submit.</p>
          ) : (
            <>
              <div className="actions">
                <span className="session-controls">
                  <span className="copies-label">copies</span>
                  <select
                    disabled={submitting || resumable != null}
                    onChange={(e) => setCopies(Number(e.target.value))}
                    value={copies}
                  >
                    <option value={1}>1 — single provider</option>
                    <option value={2}>2 — primary + secondary</option>
                    <option value={3}>3 — primary + two secondaries</option>
                  </select>
                </span>
                <button
                  className="btn primary"
                  disabled={submitting || running || allCommitted}
                  onClick={submit}
                  type="button"
                >
                  {submitting
                    ? 'Submitting…'
                    : allCommitted
                      ? 'Submitted ✓'
                      : resumable == null
                        ? `Submit ${results.length} piece${results.length === 1 ? '' : 's'}`
                        : 'Resume submit'}
                </button>
                {resumable != null && !submitting && (
                  <button className="btn small" onClick={discardSubmit} type="button">
                    Discard previous submit
                  </button>
                )}
                {underTypicalFloor > 0 && !submitting && (
                  <span className="hint">
                    {underTypicalFloor} item{underTypicalFloor === 1 ? '' : 's'} sit below the 1 MiB minimum most
                    providers advertise — submission proceeds anyway; a refusal would show per piece in the pull status,
                    and the{' '}
                    <a
                      href="https://github.com/SgtPooki/ipfs2foc/blob/main/docs/local-console.md"
                      rel="noreferrer"
                      target="_blank"
                    >
                      local packing path
                    </a>{' '}
                    covers that case
                  </span>
                )}
              </div>
              {resumable != null && !submitting && !allCommitted && (
                <p className="gate-note">
                  a previous submit for these pieces is saved — Resume continues it without re-signing or re-submitting
                  anything. Discard only forgets local progress; commits already submitted stay on chain.
                </p>
              )}
              {submitState != null && !submitState.persisted && (
                <p className="pay-setup">
                  this browser is blocking storage — progress cannot survive a reload. keep this tab open until every
                  copy reads committed.
                </p>
              )}
              {submitting && submitState?.persisted !== false && (
                <p className="gate-note">
                  providers pull and confirm on their own. closing this tab only pauses new submissions — progress is
                  saved, and Resume continues exactly where it stopped.
                </p>
              )}
              {submitError != null && (
                <p className="err-text" title={submitError}>
                  {short(submitError, 120, 0)}
                  {submitBlocked === 'session-margin' && (
                    <>
                      {' '}
                      <button className="btn small" disabled={sessionBusy != null} onClick={extend} type="button">
                        Extend session +24h
                      </button>
                    </>
                  )}
                </p>
              )}
              {submitBlocked === 'piece-too-small' && !submitting && tooSmallCids != null && (
                <div className="gate-note">
                  <p>
                    Items below the minimum ship through the local migration path, which packs them into pieces the
                    provider accepts — still signed by your wallet, no exported key. Two-part plan:
                  </p>
                  <div className="actions">
                    <button className="btn small" onClick={submitAllAnyway} type="button">
                      Submit all anyway
                    </button>
                    {eligibleCount > 0 && (
                      <button className="btn small" onClick={submitEligible} type="button">
                        Submit the {eligibleCount} item{eligibleCount === 1 ? '' : 's'} above the minimum
                      </button>
                    )}
                    <button className="btn small" onClick={saveRemainderManifest} type="button">
                      Download manifest of the {tooSmallCids.length} small item{tooSmallCids.length === 1 ? '' : 's'}
                    </button>
                    <span className="hint">
                      the minimum is the provider's advertised value — small pieces may still be accepted, and a real
                      refusal shows per piece in the pull status
                    </span>
                  </div>
                  <p>
                    Then, with that manifest and{' '}
                    <a href="https://nodejs.org" rel="noreferrer" target="_blank">
                      Node 26+
                    </a>
                    :
                  </p>
                  <ol className="steps">
                    <li>
                      <code>
                        npx ipfs2foc import-manifest manifest.json --db migrate.db --network {TARGET_NETWORK}{' '}
                        --no-auto-pack
                      </code>
                    </li>
                    <li>
                      <code>npx ipfs2foc pack-cars --db migrate.db --car-store ./cars</code>
                    </li>
                    <li>
                      <code>npx ipfs2foc serve --db migrate.db --ingress cloudflared --network {TARGET_NETWORK}</code> —
                      open the printed console, grant a signing session, press Submit
                    </li>
                  </ol>
                  <p>
                    <a
                      href="https://github.com/SgtPooki/ipfs2foc/blob/main/docs/local-console.md"
                      rel="noreferrer"
                      target="_blank"
                    >
                      Local console guide
                    </a>{' '}
                    — nothing is lost: anything committed here stays committed, and the manifest carries the rest over.
                  </p>
                </div>
              )}
              {allCommitted && !submitting && (
                <p className="gate-note">
                  every copy is committed — revoke the signing session above once you are done migrating.
                </p>
              )}
            </>
          )}
          {submitState != null && submitState.contexts.length > 0 && (
            <div className="table">
              <div className="trow thead submit-row">
                <span>Copy</span>
                <span>Provider</span>
                <span>Status</span>
                <span>Data set</span>
              </div>
              {submitState.contexts.map((c) => (
                <div className="trow submit-row" key={c.providerId}>
                  <span className="dim">{c.role}</span>
                  <span className="mono dim" title={c.serviceURL}>
                    {c.providerName || `#${c.providerId}`}
                  </span>
                  {c.phase === 'failed' ? (
                    <span className="err-text" title={c.error}>
                      {short(c.error ?? 'failed', 36, 0)}
                    </span>
                  ) : (
                    <span className={c.phase === 'done' ? 'ok-text' : 'working'}>{describeSubmitPhase(c)}</span>
                  )}
                  <span className="mono dim">
                    {(() => {
                      const txHash = [...c.chunks].reverse().find((ch) => ch.txHash != null)?.txHash
                      return c.dataSetId == null
                        ? txHash == null
                          ? '—'
                          : short(txHash, 10, 4)
                        : `#${c.dataSetId} · ${c.pieceIds?.length ?? 0} piece${c.pieceIds?.length === 1 ? '' : 's'}`
                    })()}
                    {c.dataSetId != null && (
                      <>
                        {' '}
                        <button
                          className="btn small"
                          disabled={submitting || verifying != null}
                          onClick={() => void verifyContext(c.providerId)}
                          type="button"
                        >
                          {verifying === c.providerId ? 'Verifying…' : 'Verify on chain'}
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          {verifyError != null && <p className="err-text">{verifyError}</p>}
          {submitState?.contexts.map((c) => {
            const report = verifyReports[c.providerId]
            if (report == null) return null
            const { result, network, dataSetId, cleared } = report
            const h = result.health
            return (
              <div className="gate-note" key={`verify-${c.providerId}`}>
                <p>
                  <a href={explorerDataSetUrl(network, dataSetId)} rel="noreferrer" target="_blank">
                    Data set #{dataSetId}
                  </a>{' '}
                  on {network}, read from the chain just now: {h.live ? 'live' : 'DELETED'},{' '}
                  {h.activePieceCount.toString()} active piece{h.activePieceCount === 1n ? '' : 's'} ·{' '}
                  {result.found.size} of {result.found.size + result.missing.length} pieces from this run are on it.
                  {cleared > 0 && (
                    <>
                      {' '}
                      {cleared} previously-skipped piece{cleared === 1 ? ' is' : 's are'} actually committed — their
                      skipped state is cleared.
                    </>
                  )}
                </p>
                <p>
                  {h.lastProvenEpoch == null
                    ? 'The provider has not yet submitted a proof of possession for this data set.'
                    : h.provenSinceAdd
                      ? `Possession proven: the provider's last accepted proof (epoch ${h.lastProvenEpoch}) covers everything this run added.`
                      : `The provider has proven possession (epoch ${h.lastProvenEpoch}), but not yet since this run's last add — the next proof will cover it.`}{' '}
                  {h.inGoodStanding ? 'Proving deadline not missed.' : 'The next proving deadline has passed.'}
                </p>
                {result.missing.length > 0 && (
                  <>
                    <p>
                      {result.missing.length} piece{result.missing.length === 1 ? '' : 's'} from this run{' '}
                      {result.missing.length === 1 ? 'is' : 'are'} not on the data set under{' '}
                      {result.missing.length === 1 ? 'its' : 'their'} own PieceCID. A piece migrated through the local
                      packing path lives on chain under the packed piece's CID instead, which this page cannot match up
                      — <code>ipfs2foc report</code> on the local database reconciles those.
                    </p>
                    <ul className="mono">
                      {result.missing.slice(0, 8).map((p) => (
                        <li key={p}>
                          <a href={explorerPieceUrl(network, p)} rel="noreferrer" target="_blank">
                            {short(p, 16, 8)}
                          </a>
                        </li>
                      ))}
                      {result.missing.length > 8 && <li>… and {result.missing.length - 8} more</li>}
                    </ul>
                  </>
                )}
                {result.unrecognized.length > 0 && (
                  <p>
                    The data set also holds {result.unrecognized.length} piece
                    {result.unrecognized.length === 1 ? '' : 's'} this run did not prepare — typically packed pieces
                    committed from the local console against the same data set.
                  </p>
                )}
              </div>
            )
          })}
          {deferredCids.length > 0 && !submitting && (
            <div className="gate-note">
              <p>
                {deferredCids.length} piece{deferredCids.length === 1 ? ' was' : 's were'} skipped: the provider could
                not fetch them from their source after retries (the "check availability" links above show why).
                Everything else committed. If the source recovers — or you host the bytes another way — retry here;
                otherwise the remainder manifest carries them to the{' '}
                <a
                  href="https://github.com/SgtPooki/ipfs2foc/blob/main/docs/local-console.md"
                  rel="noreferrer"
                  target="_blank"
                >
                  local path
                </a>
                . Already migrated them elsewhere? Verify on chain above clears the ones the chain has.
              </p>
              <div className="actions">
                {session != null && (
                  <button className="btn small" onClick={() => void retryDeferred()} type="button">
                    Retry the skipped piece{deferredCids.length === 1 ? '' : 's'}
                  </button>
                )}
                {results.length > 0 && (
                  <button className="btn small" onClick={saveDeferredManifest} type="button">
                    Download manifest of the skipped piece{deferredCids.length === 1 ? '' : 's'}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <footer className="foot">
        <span>
          piece commitment computed locally over hash-verified blocks in canonical CAR form; the relay streams the same
          canonical bytes to the provider, rebuilding anything the gateway truncates
        </span>
        <a href="https://github.com/SgtPooki/ipfs2foc" rel="noreferrer" target="_blank">
          SgtPooki/ipfs2foc
        </a>
      </footer>
    </div>
  )
}
