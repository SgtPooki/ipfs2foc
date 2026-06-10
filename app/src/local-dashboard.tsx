/**
 * Control plane for a local `ipfs2foc serve` daemon. The server owns the DB
 * and the commP/packing runner; this view polls GET /api/status and drives it:
 * start/pause/resume, retry failures, add CIDs, set gateways. Replaces the
 * inline dashboard page the CLI used to ship — same console bundle, picked at
 * startup by GET /api/capabilities (see capabilities.ts).
 *
 * On-chain submission (when the daemon reports supportsBrowserSigning): the
 * wallet grants a scoped session key in the Signing panel, the daemon holds
 * it and drives presign/pull/add itself — the Submit panel just starts the
 * run and the Aggregates table shows its lifecycle. Without signing support
 * the panel falls back to copyable CLI commands.
 */

import type { Capabilities } from 'ipfs2foc-core/capabilities'
import { useCallback, useEffect, useRef, useState } from 'react'
import LocalSigningPanel, { type ServerSessionInfo } from './local-signing.tsx'

interface ServeStatus {
  state: 'idle' | 'running' | 'paused'
  active: number
  gateways: string[]
  aggregateSizeBytes: string
  dbPath: string
  lastError: string | null
  counts: { pending: number; processing: number; done: number; failed: number }
  aggregates: Array<{
    idx: number
    status: string
    memberCount: number
    dataSetId: string | null
    pieceId: string | null
    rootPieceCid: string
  }>
  failures: Array<{ cid: string; error: string; category?: string }>
  gas: { baseFee: string; multipleOfFloor: number; level: string; pause: boolean } | null
  // Optional: a server older than the piece-ingress feature omits it.
  ingress?: { publicBase: string | null; reachable: boolean | null } | null
  // Optional: servers without browser signing omit both.
  session?: ServerSessionInfo | null
  submit?: {
    running: boolean
    kind?: 'submit' | 'create-data-set'
    dataSetId: number | null
    startedAt: string | null
    finishedAt?: string | null
    lastError: string | null
    lastResult?: { dataSetId: number; txHash: string } | null
  } | null
}

/** 409 reasons from POST /api/submit and /api/data-sets, in operator words. */
const REFUSAL_MESSAGES: Record<string, string> = {
  'no-session': 'no signing session on the daemon — grant one in the Signing panel',
  'session-margin': 'the session expires within the safety margin — extend it in the Signing panel, then retry',
  'ingress-unreachable': 'providers cannot reach this daemon — check the pieces chip / tunnel, then retry',
  'job-running': 'a chain job is already in progress — wait for it to finish',
  'network-mismatch': 'the session targets a different network than this daemon',
}

const POLL_MS = 2000

function trunc(s: string): string {
  return s.length > 30 ? `${s.slice(0, 14)}…${s.slice(-10)}` : s
}

function fmtSize(bytes: string): string {
  const n = Number(bytes)
  if (!n) return '—'
  const gib = n / 1073741824
  return gib >= 1 ? `${gib.toFixed(0)} GiB` : `${(n / 1048576).toFixed(0)} MiB`
}

export default function LocalDashboard({ caps }: { caps: Capabilities }) {
  const api = caps.apiBase ?? '/api'
  const [status, setStatus] = useState<ServeStatus | null>(null)
  const [stale, setStale] = useState(false)
  const [cidsText, setCidsText] = useState('')
  const [gatewaysText, setGatewaysText] = useState('')
  const [addMsg, setAddMsg] = useState('')
  const [gwMsg, setGwMsg] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [dataSetIdText, setDataSetIdText] = useState('')
  const [providerIdText, setProviderIdText] = useState('')
  const [submitMsg, setSubmitMsg] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${api}/status`)
      if (!res.ok) throw new Error(`status ${res.status}`)
      setStatus((await res.json()) as ServeStatus)
      setStale(false)
    } catch {
      setStale(true)
    }
  }, [api])

  useEffect(() => {
    void refresh()
    timer.current = setInterval(() => void refresh(), POLL_MS)
    return () => {
      if (timer.current != null) clearInterval(timer.current)
    }
  }, [refresh])

  const post = useCallback(
    async (action: string, body?: string, type?: string): Promise<unknown> => {
      const res = await fetch(`${api}/${action}`, {
        method: 'POST',
        ...(body == null ? {} : { body, headers: { 'content-type': type ?? 'text/plain' } }),
      })
      const out: unknown = await res.json()
      void refresh()
      return out
    },
    [api, refresh]
  )

  const addCids = useCallback(async () => {
    const res = (await post('cids', cidsText)) as { added: number }
    setAddMsg(`added ${res.added}`)
    setCidsText('')
  }, [post, cidsText])

  const setGateways = useCallback(async () => {
    const gateways = gatewaysText.split(/[\s,]+/).filter(Boolean)
    const res = (await post('gateways', JSON.stringify({ gateways }), 'application/json')) as { gateways: string[] }
    setGwMsg(`set ${res.gateways.length}`)
  }, [post, gatewaysText])

  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(text)
      setTimeout(() => setCopied((c) => (c === text ? null : c)), 900)
    })
  }, [])

  const postChainJob = useCallback(
    async (path: string, body: unknown) => {
      setSubmitMsg(null)
      const res = await fetch(`${api}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as { reason?: string; error?: string } | null
        setSubmitMsg(REFUSAL_MESSAGES[parsed?.reason ?? ''] ?? parsed?.error ?? `request failed (${res.status})`)
      }
      void refresh()
    },
    [api, refresh]
  )

  const startSubmit = useCallback(
    () => postChainJob('submit', { dataSetId: Number(dataSetIdText.trim()) }),
    [postChainJob, dataSetIdText]
  )
  const createDataSet = useCallback(
    () => postChainJob('data-sets', { providerId: Number(providerIdText.trim()) }),
    [postChainJob, providerIdText]
  )

  const counts = status?.counts ?? { pending: 0, processing: 0, done: 0, failed: 0 }
  const total = counts.done + counts.processing + counts.pending + counts.failed || 1
  const state = status?.state ?? 'idle'
  const running = state === 'running'
  const paused = state === 'paused'
  const aggregates = status?.aggregates ?? []
  const parked = aggregates.filter(
    (a) => a.status === 'submitted' || a.status === 'parked' || a.status === 'add_unconfirmed'
  ).length
  const committed = aggregates.filter((a) => a.status === 'committed').length
  const toCommit = aggregates.filter((a) => a.status !== 'committed' && a.status !== 'failed').length
  const failures = status?.failures ?? []
  const db = status?.dbPath ?? 'migrate.db'
  const net = caps.network === 'calibration' ? ' --network calibration' : ''
  // With public ingress up, this daemon already serves /piece — the hints
  // skip the separate redirect server and point pdp-submit straight at it.
  const publicBase = status?.ingress?.publicBase ?? null
  const reachable = status?.ingress?.reachable ?? null
  const commitCmds: Array<[string, string]> =
    publicBase == null
      ? [
          [`ipfs2foc create-data-set --provider-id <id>${net}`, 'once per provider · skip if reusing a data set'],
          [`ipfs2foc redirect-serve --db ${db} --ingress cloudflared --port 4322`, 'terminal A · leave running'],
          [`ipfs2foc pdp-submit --db ${db} --data-set-id <id> --source-base https://<host>${net}`, 'terminal B'],
          [`ipfs2foc report --db ${db} --data-set-id <id>${net}`, 'confirm on chain'],
        ]
      : [
          [`ipfs2foc create-data-set --provider-id <id>${net}`, 'once per provider · skip if reusing a data set'],
          [`ipfs2foc pdp-submit --db ${db} --data-set-id <id> --source-base ${publicBase}${net}`, 'second terminal'],
          [`ipfs2foc report --db ${db} --data-set-id <id>${net}`, 'confirm on chain'],
        ]

  const signing = caps.supportsBrowserSigning
  const serverSession = status?.session ?? null
  const submitJob = status?.submit ?? null
  const sessionReady = serverSession?.present === true && serverSession.valid === true

  // Sections after Aggregates are conditional — number them in render order.
  let panelIndex = 2
  const nextPanelNo = () => String(++panelIndex).padStart(2, '0')

  return (
    <div className="shell" style={stale ? { opacity: 0.6 } : undefined}>
      <div aria-hidden className="grid-overlay" />
      <header className="masthead">
        <div className="brand">
          <span className="mark">ipfs2foc</span>
          <span className="sub">migration control · local</span>
        </div>
        <div className="net-badge">
          <span className={`chip ${stale ? 'chip-warn' : 'chip-ok'}`}>{stale ? 'reconnecting…' : state}</span>
          <span className="chip">{caps.network}</span>
          {publicBase == null ? (
            <span
              className="chip"
              title="providers cannot pull yet — restart with --ingress cloudflared or --public-base"
            >
              pieces · local only
            </span>
          ) : (
            <span
              className={`chip ${reachable == null ? '' : reachable ? 'chip-ok' : 'chip-warn'}`}
              title={`providers pull from ${publicBase}/piece/{pieceCid}`}
            >
              pieces · {publicBase.replace(/^https:\/\//, '')}
              {reachable == null ? ' · checking' : reachable ? '' : ' · unreachable'}
            </span>
          )}
          <span
            className="chip"
            title={
              status?.gas == null ? 'base-fee monitor is off — start serve with --network or --rpc-url to enable' : ''
            }
          >
            {status?.gas == null
              ? 'base fee · off'
              : `base fee ${status.gas.baseFee} · ${status.gas.multipleOfFloor}× · ${status.gas.pause ? 'SPIKE — pause' : status.gas.level}`}
          </span>
        </div>
      </header>

      <p className="lede">
        This daemon computes piece commitments and packs aggregates in the background — add CIDs, press start, close the
        tab whenever. State lives in <code className="mono">{db}</code>.
      </p>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-no">01</span>
          <h2>Pipeline</h2>
          <span className="panel-note">piece target {fmtSize(status?.aggregateSizeBytes ?? '0')}</span>
        </div>
        <div
          className="flowbar"
          title={`${counts.done} done · ${counts.processing} processing · ${counts.pending} pending · ${counts.failed} failed`}
        >
          <i className="seg-done" style={{ width: `${(100 * counts.done) / total}%` }} />
          <i className="seg-proc" style={{ width: `${(100 * counts.processing) / total}%` }} />
          <i className="seg-pend" style={{ width: `${(100 * counts.pending) / total}%` }} />
          <i className="seg-fail" style={{ width: `${(100 * counts.failed) / total}%` }} />
        </div>
        <div className="tiles">
          <div className="tile">
            <span className="tile-k">done</span>
            <span className="tile-v">{counts.done}</span>
          </div>
          <div className="tile">
            <span className="tile-k">processing</span>
            <span className="tile-v">{counts.processing}</span>
          </div>
          <div className="tile">
            <span className="tile-k">pending</span>
            <span className="tile-v">{counts.pending}</span>
          </div>
          <div className="tile">
            <span className="tile-k">failed</span>
            <span className="tile-v">{counts.failed}</span>
          </div>
          <div className="tile">
            <span className="tile-k">aggregates</span>
            <span className="tile-v">{aggregates.length}</span>
          </div>
          <div className="tile">
            <span className="tile-k">parked · uncommitted</span>
            <span className="tile-v">{parked}</span>
          </div>
          <div className="tile">
            <span className="tile-k">workers</span>
            <span className="tile-v">{status?.active ?? 0}</span>
          </div>
        </div>
        <div className="actions">
          <button
            className="btn primary"
            disabled={running || paused || counts.pending <= 0}
            onClick={() => void post('start')}
            type="button"
          >
            ▸ Start
          </button>
          <button className="btn" disabled={!running} onClick={() => void post('pause')} type="button">
            ❙❙ Pause
          </button>
          <button className="btn" disabled={!paused} onClick={() => void post('resume')} type="button">
            ▸ Resume
          </button>
          <button className="btn" disabled={counts.failed <= 0} onClick={() => void post('retry')} type="button">
            ⟳ Retry failed
          </button>
          {status?.lastError && <span className="err-text">last error · {status.lastError}</span>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-no">02</span>
          <h2>Aggregates</h2>
          <span className="panel-note">
            {aggregates.length ? `${committed} committed · ${aggregates.length} total` : '—'}
          </span>
        </div>
        {aggregates.length === 0 ? (
          <p className="dim">No aggregates planned yet. Add CIDs to begin.</p>
        ) : (
          <div className="table">
            <div className="trow thead agg-row">
              <span>#</span>
              <span>status</span>
              <span>members</span>
              <span>data set</span>
              <span>piece</span>
              <span>root pieceCID</span>
            </div>
            {aggregates.map((a) => (
              <div className="trow agg-row" key={a.idx}>
                <span className="num">{a.idx}</span>
                <span className={a.status === 'failed' ? 'err-text' : a.status === 'committed' ? 'ok-text' : undefined}>
                  {a.status.replace(/_/g, ' ')}
                </span>
                <span className="num">{a.memberCount}</span>
                <span className="num">{a.dataSetId ?? '—'}</span>
                <span className="num">{a.pieceId ?? '—'}</span>
                <button
                  className={`copy mono${copied === a.rootPieceCid ? ' ok-text' : ''}`}
                  onClick={() => copy(a.rootPieceCid)}
                  title={a.rootPieceCid}
                  type="button"
                >
                  {trunc(a.rootPieceCid)}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {signing && (
        <LocalSigningPanel
          apiBase={api}
          network={caps.network}
          onChanged={() => void refresh()}
          panelNo={nextPanelNo()}
          serverSession={serverSession}
        />
      )}

      {signing && toCommit > 0 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-no">{nextPanelNo()}</span>
            <h2>Submit on chain</h2>
            <span className="panel-note">{toCommit} aggregate(s) to commit</span>
          </div>
          <p className="hint">
            The daemon pulls each aggregate to the provider and lands the on-chain add, signing with the session key —
            progress shows in the Aggregates table. A data set id is reusable across runs.
          </p>
          <div className="field">
            <span>data set id</span>
            <input onChange={(e) => setDataSetIdText(e.target.value)} placeholder="42" value={dataSetIdText} />
          </div>
          <div className="actions">
            <button
              className="btn primary"
              disabled={
                submitJob?.running === true ||
                !sessionReady ||
                reachable !== true ||
                !/^\d+$/.test(dataSetIdText.trim())
              }
              onClick={() => void startSubmit()}
              type="button"
            >
              Submit on chain
            </button>
            {submitJob?.running === true && (
              <span className="chip">
                {submitJob.kind === 'create-data-set'
                  ? 'creating data set…'
                  : `submitting to data set ${submitJob.dataSetId}…`}
              </span>
            )}
            {!sessionReady && <span className="hint">needs a signing session (panel above)</span>}
            {sessionReady && reachable !== true && (
              <span className="hint">needs reachable public ingress (pieces chip)</span>
            )}
          </div>
          <div className="field">
            <span>new data set</span>
            <input
              onChange={(e) => setProviderIdText(e.target.value)}
              placeholder="provider id"
              value={providerIdText}
            />
          </div>
          <div className="actions">
            <button
              className="btn"
              disabled={submitJob?.running === true || !sessionReady || !/^\d+$/.test(providerIdText.trim())}
              onClick={() => void createDataSet()}
              type="button"
            >
              Create data set
            </button>
            {submitJob?.lastResult != null && (
              <span className="dim">
                data set {submitJob.lastResult.dataSetId} · tx{' '}
                <button
                  className={`copy mono${copied === submitJob.lastResult.txHash ? ' ok-text' : ''}`}
                  onClick={() => submitJob.lastResult != null && copy(submitJob.lastResult.txHash)}
                  type="button"
                >
                  {trunc(submitJob.lastResult.txHash)}
                </button>
              </span>
            )}
          </div>
          {submitMsg && <p className="err-text">{submitMsg}</p>}
          {submitJob?.lastError != null && submitJob.running === false && (
            <p className="err-text">last run: {submitJob.lastError}</p>
          )}
        </section>
      )}

      {!signing && toCommit > 0 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-no">{nextPanelNo()}</span>
            <h2>Commit on chain</h2>
            <span className="panel-note">{toCommit} aggregate(s) to commit</span>
          </div>
          <p className="hint">
            This daemon runs the commP + packing stage. Putting aggregates on chain is done from the CLI — those
            commands sign with <code className="mono">PRIVATE_KEY</code> and need a public HTTPS ingress. Click a
            command to copy.
          </p>
          <ol className="steps">
            {commitCmds.map(([cmd, hint]) => (
              <li key={cmd}>
                <button
                  className={`copy mono${copied === cmd ? ' ok-text' : ''}`}
                  onClick={() => copy(cmd)}
                  title="click to copy"
                  type="button"
                >
                  {cmd}
                </button>
                <em className="hint"> {hint}</em>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <span className="panel-no">{nextPanelNo()}</span>
          <h2>Add CIDs</h2>
        </div>
        <textarea
          className="cid-input"
          onChange={(e) => setCidsText(e.target.value)}
          placeholder={'bafy…\nQm…\n(one CID per line)'}
          rows={5}
          value={cidsText}
        />
        <div className="actions">
          <button className="btn" disabled={cidsText.trim() === ''} onClick={() => void addCids()} type="button">
            Add CIDs
          </button>
          <span className="dim">{addMsg}</span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-no">{nextPanelNo()}</span>
          <h2>Gateways</h2>
        </div>
        <div className="field">
          <span>gateways</span>
          <input
            onChange={(e) => setGatewaysText(e.target.value)}
            placeholder="https://trustless-gateway.link"
            value={gatewaysText}
          />
        </div>
        <div className="actions">
          <button
            className="btn"
            disabled={gatewaysText.trim() === ''}
            onClick={() => void setGateways()}
            type="button"
          >
            Set gateways
          </button>
          <span className="dim">{gwMsg}</span>
          {(status?.gateways ?? []).map((g) => (
            <span className="chip" key={g}>
              {g}
            </span>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-no">{nextPanelNo()}</span>
          <h2>Failures</h2>
          <span className="panel-note">{failures.length}</span>
        </div>
        {failures.length === 0 ? (
          <p className="dim">No failures.</p>
        ) : (
          <div className="table">
            {failures.map((f) => (
              <div className="trow fail-row" key={f.cid}>
                <button className="copy mono" onClick={() => copy(f.cid)} title={f.cid} type="button">
                  {trunc(f.cid)}
                </button>
                <span className="err-text">{f.category ?? ''}</span>
                <span className="dim">{f.error}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="foot">
        <span className={stale ? 'err-text' : 'ok-text'}>{stale ? '● reconnecting' : '● connected'}</span>
        <span className="dim"> / polls every 2s</span>
      </footer>
    </div>
  )
}
