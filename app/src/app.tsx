import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { computePiece, type PieceResult } from './commp.ts'
import { HASH_POOL_SIZE } from './hash-pool.ts'
import { buildManifest, downloadManifest } from './manifest.ts'
import { fmtToken, type PaymentsStatus, readPaymentsStatus, readyToSign } from './payments.ts'
import { clearRun, loadRun, saveRun } from './run-store.ts'
import { connectWallet, NETWORKS, networkOf, refreshWallet, switchToCalibration, type WalletState } from './wallet.ts'

const DEFAULT_RELAY = 'https://ipfs2foc-relay.russell-3c4.workers.dev'
const DEFAULT_GATEWAY = 'https://trustless-gateway.link'
const TARGET_NETWORK = 'calibration' as const

type RowState =
  | { phase: 'queued' }
  | { phase: 'working'; bytes: number; rate: number }
  | { phase: 'done'; result: PieceResult }
  | { phase: 'error'; message: string }

// Process several CIDs at once. Retrieval and CAR assembly share one helia
// node on this thread; the CPU-bound hashing runs in pooled workers, one core
// per concurrent piece.
const CONCURRENCY = HASH_POOL_SIZE
// Don't re-render on every stream chunk — that starves the thread doing the
// hashing. Emit progress at most this often.
const PROGRESS_THROTTLE_MS = 250

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

function Led({ on, color }: { on: boolean; color: string }) {
  return <span className="led" style={{ background: on ? color : 'transparent', borderColor: color }} />
}

export default function App() {
  const [wallet, setWallet] = useState<WalletState | null>(null)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [payments, setPayments] = useState<PaymentsStatus | null>(null)
  const [paymentsError, setPaymentsError] = useState<string | null>(null)
  const [paymentsLoading, setPaymentsLoading] = useState(false)
  const [cidsText, setCidsText] = useState('')
  const [relayBase, setRelayBase] = useState(DEFAULT_RELAY)
  const [gateway, setGateway] = useState(DEFAULT_GATEWAY)
  const [rows, setRows] = useState<Row[]>([])
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  // Completed pieces by input CID — the write-through copy of what run-store
  // persists, and the source for skip-on-resume in run().
  const savedResults = useRef<Record<string, PieceResult>>({})
  const [restored, setRestored] = useState(false)
  // Writes are blocked until the restore attempt settles, so an early debounced
  // persist of the empty textarea cannot clobber a saved run.
  const hydrated = useRef(false)

  // Restore the previous run once on load (#26). Done rows come back as done;
  // anything else shows queued and recomputes on the next prepare.
  useEffect(() => {
    loadRun().then((saved) => {
      hydrated.current = true
      if (saved == null) return
      savedResults.current = saved.results
      setCidsText(saved.cidsText)
      setRelayBase(saved.relayBase)
      setGateway(saved.gateway)
      const savedCids = Array.from(
        new Set(
          saved.cidsText
            .split(/\s+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        )
      )
      const doneCount = savedCids.filter((cid) => saved.results[cid] != null).length
      if (doneCount > 0) {
        setRows(
          savedCids.map((cid) => {
            const result = saved.results[cid]
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
        gateway,
        relayBase,
        results: savedResults.current,
        updatedAt: new Date().toISOString(),
      })
    },
    [gateway, relayBase]
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
        )
      ),
    [cidsText]
  )

  const results = useMemo(() => rows.flatMap((r) => (r.state.phase === 'done' ? [r.state.result] : [])), [rows])
  const errors = rows.filter((r) => r.state.phase === 'error').length
  const walletNetwork = wallet == null ? null : networkOf(wallet.chainId)
  const onCalibration = walletNetwork === TARGET_NETWORK

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

  const run = useCallback(async () => {
    setRunning(true)
    // Prune saved results for CIDs no longer in the input, then seed done rows
    // from the saved run — pieces are deterministic, so a saved result is final
    // and only the pending/failed CIDs go back through a worker.
    savedResults.current = Object.fromEntries(
      Object.entries(savedResults.current).filter(([cid]) => cids.includes(cid))
    )
    setRows(
      cids.map((cid) => {
        const result = savedResults.current[cid]
        return { cid, state: result ? { phase: 'done', result } : { phase: 'queued' } }
      })
    )
    persist(cidsText)
    const patch = (i: number, state: RowState) =>
      setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, state } : r)))

    const processOne = async (i: number) => {
      const startedAt = performance.now()
      let lastEmit = 0
      patch(i, { phase: 'working', bytes: 0, rate: 0 })
      try {
        const result = await computePiece(gateway, cids[i], relayBase, (bytes) => {
          const now = performance.now()
          if (now - lastEmit < PROGRESS_THROTTLE_MS) return
          lastEmit = now
          const secs = (now - startedAt) / 1000
          patch(i, { phase: 'working', bytes, rate: secs > 0 ? bytes / 1048576 / secs : 0 })
        })
        patch(i, { phase: 'done', result })
        savedResults.current[cids[i]] = result
        persist(cidsText)
      } catch (err) {
        patch(i, { phase: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }

    // Worker pool over the CID indices that still need computing.
    const pendingIdx = cids.flatMap((cid, i) => (savedResults.current[cid] ? [] : [i]))
    let next = 0
    const worker = async () => {
      while (next < pendingIdx.length) {
        await processOne(pendingIdx[next++])
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pendingIdx.length) }, worker))
    setRunning(false)
  }, [cids, cidsText, gateway, relayBase, persist])

  const reset = useCallback(() => {
    savedResults.current = {}
    setRows([])
    setCidsText('')
    setRestored(false)
    void clearRun()
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
        network: TARGET_NETWORK,
        relayBase,
        gateway,
        now: new Date().toISOString(),
      })
    )
  }, [results, relayBase, gateway])

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
            ) : paymentsError != null ? (
              <span className="err-text" title={paymentsError}>
                payment status unavailable: {short(paymentsError, 48, 0)}
              </span>
            ) : payments != null ? (
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
              </>
            ) : null}
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
          placeholder={'bafybei…\nQm…  (CIDv0 or CIDv1, one per line)'}
          spellCheck={false}
          value={cidsText}
        />
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
                    <code className="mono" title={r.state.result.pieceCid}>
                      {short(r.state.result.pieceCid)}
                    </code>
                  ) : r.state.phase === 'error' ? (
                    <span className="err-text" title={r.state.message}>
                      {short(r.state.message, 28, 0)}
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
                  ) : (
                    <span className="dim">—</span>
                  )}
                </div>
              )
            })}
          </div>
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

      <footer className="foot">
        <span>
          piece commitment computed locally over hash-verified blocks in canonical CAR form; redirect relay 302s the
          provider pull to the same bytes at the gateway
        </span>
        <a href="https://github.com/SgtPooki/ipfs2foc" rel="noreferrer" target="_blank">
          SgtPooki/ipfs2foc
        </a>
      </footer>
    </div>
  )
}
