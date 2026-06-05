import { useCallback, useMemo, useState } from 'react'
import { computePiece, type PieceResult } from './commp.ts'
import { buildManifest, downloadManifest } from './manifest.ts'
import { connectWallet, NETWORKS, networkOf, type WalletState } from './wallet.ts'

const DEFAULT_RELAY = 'https://ipfs2foc-relay.russell-3c4.workers.dev'
const DEFAULT_GATEWAY = 'https://trustless-gateway.link'
const TARGET_NETWORK = 'calibration' as const

type RowState =
  | { phase: 'queued' }
  | { phase: 'working'; bytes: number }
  | { phase: 'done'; result: PieceResult }
  | { phase: 'error'; message: string }

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
  const [cidsText, setCidsText] = useState('')
  const [relayBase, setRelayBase] = useState(DEFAULT_RELAY)
  const [gateway, setGateway] = useState(DEFAULT_GATEWAY)
  const [rows, setRows] = useState<Row[]>([])
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

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

  const connect = useCallback(async () => {
    setWalletError(null)
    try {
      setWallet(await connectWallet())
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const run = useCallback(async () => {
    setRunning(true)
    const initial: Row[] = cids.map((cid) => ({ cid, state: { phase: 'queued' } }))
    setRows(initial)
    const patch = (i: number, state: RowState) =>
      setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, state } : r)))

    for (let i = 0; i < cids.length; i++) {
      patch(i, { phase: 'working', bytes: 0 })
      try {
        const result = await computePiece(gateway, cids[i], relayBase, (bytes) => patch(i, { phase: 'working', bytes }))
        patch(i, { phase: 'done', result })
      } catch (err) {
        patch(i, { phase: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }
    setRunning(false)
  }, [cids, gateway, relayBase])

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
              {!onCalibration && <span className="hint">switch your wallet to Calibration (314159)</span>}
            </div>
          )}
          {walletError && <span className="err-text">{walletError}</span>}
        </div>
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
          placeholder={'bafybei…\nbafybei…  (one CIDv1 per line)'}
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
        </div>
      </section>

      {rows.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-no">03</span>
            <h2>Pieces</h2>
            <span className="panel-note">
              {results.length} ready{errors > 0 ? ` · ${errors} failed` : ''}
            </span>
          </div>
          <div className="table">
            <div className="trow thead">
              <span>CID</span>
              <span>PieceCID</span>
              <span className="num">Size</span>
              <span>Pull URL</span>
            </div>
            {rows.map((r) => (
              <div className="trow" key={r.cid}>
                <code className="mono dim" title={r.cid}>
                  {short(r.cid)}
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
                  <span className="working">▍ {fmtBytes(r.state.bytes)}</span>
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
            ))}
          </div>
          {results.length > 0 && (
            <div className="actions">
              <button className="btn" onClick={saveManifest} type="button">
                Download run manifest ({results.length})
              </button>
              <span className="panel-note">
                feed this to <code>ipfs2foc pdp-submit --source-relay</code> to submit the migration
              </span>
            </div>
          )}
        </section>
      )}

      <footer className="foot">
        <span>
          piece commitment computed locally via <code>@web3-storage/data-segment</code>; redirect relay 302s the
          provider pull to the gateway CAR
        </span>
        <a href="https://github.com/SgtPooki/ipfs2foc" rel="noreferrer" target="_blank">
          SgtPooki/ipfs2foc
        </a>
      </footer>
    </div>
  )
}
