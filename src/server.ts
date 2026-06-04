/**
 * Daemon + status dashboard. A tiny node:http server that owns a Runner and the
 * DB, so a migration can run in the background while the operator watches
 * progress and controls it from a browser: start/pause/resume, add CIDs (paste
 * or upload a .txt), add gateways, retry failures.
 *
 * No web framework — just node:http and an inline HTML page that polls
 * /api/status. JSON APIs are curl-friendly for scripting too.
 */

import { createServer } from 'node:http'
import type { MigrationDB } from './db.ts'
import { type BaseFeeReading, classifyBaseFee, getBaseFee } from './gas.ts'
import type { Runner } from './runner.ts'
import { log, parseCidList } from './util.ts'

export interface GasConfig {
  rpcUrl: string
  maxBaseFee: bigint
}

export function startServer(db: MigrationDB, runner: Runner, port: number, gas?: GasConfig): void {
  // Poll the network base fee in the background so the dashboard can show it and
  // flag when submission should pause. Read-only; never blocks the commP loop.
  let baseFee: BaseFeeReading | null = null
  if (gas != null) {
    const poll = async (): Promise<void> => {
      try {
        baseFee = classifyBaseFee(await getBaseFee(gas.rpcUrl), gas.maxBaseFee)
      } catch (err) {
        log(`baseFee poll failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    void poll()
    setInterval(() => void poll(), 20_000).unref()
  }
  const gasStatus = (): unknown =>
    baseFee == null
      ? null
      : {
          baseFee: baseFee.baseFee.toString(),
          multipleOfFloor: baseFee.multipleOfFloor,
          level: baseFee.level,
          pause: baseFee.pause,
          maxBaseFee: gas?.maxBaseFee.toString() ?? null,
        }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = `${req.method} ${url.pathname}`

    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    const readBody = async (): Promise<string> => {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(chunk as Buffer)
      }
      return Buffer.concat(chunks).toString('utf8')
    }

    void (async () => {
      try {
        switch (route) {
          case 'GET /':
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end(DASHBOARD_HTML)
            return

          case 'GET /api/status':
            json(200, { ...(status(db, runner) as object), gas: gasStatus() })
            return

          case 'POST /api/start':
            runner.start()
            json(200, { state: runner.state })
            return

          case 'POST /api/pause':
            runner.pause()
            json(200, { state: runner.state })
            return

          case 'POST /api/resume':
            runner.resume()
            json(200, { state: runner.state })
            return

          case 'POST /api/retry':
            runner.retryFailed()
            json(200, { state: runner.state })
            return

          case 'POST /api/cids': {
            const cids = parseCidList(await readBody())
            const added = runner.addCids(cids)
            json(200, { added, cids: cids.length })
            return
          }

          case 'POST /api/gateways': {
            const body = await readBody()
            let gateways: string[]
            try {
              const parsed = JSON.parse(body)
              gateways = Array.isArray(parsed) ? parsed : parsed.gateways
            } catch {
              gateways = body.split(/[\s,]+/).filter(Boolean)
            }
            runner.setGateways(gateways)
            json(200, { gateways: runner.gateways })
            return
          }

          default:
            json(404, { error: `no route ${route}` })
        }
      } catch (err) {
        json(500, { error: err instanceof Error ? err.message : String(err) })
      }
    })()
  })

  server.listen(port, () => {
    log(`ipfs2foc dashboard on http://localhost:${port}`)
  })
}

function status(db: MigrationDB, runner: Runner): unknown {
  return {
    state: runner.state,
    active: runner.active,
    gateways: runner.gateways,
    aggregateSizeBytes: runner.aggregateSizeBytes.toString(),
    dbPath: db.path,
    lastError: runner.lastError,
    counts: db.counts(),
    aggregates: db.aggregates(),
    failures: db.failures().slice(0, 50),
  }
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ipfs2foc · migration control</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  :root {
    color-scheme: dark;
    --ink: #08090c; --panel: #0e1014; --raised: #14171d;
    --line: rgba(255,255,255,.07); --line-2: rgba(255,255,255,.13);
    --text: #e8eaef; --muted: #8b919d; --faint: #565d6a;
    --signal: #46e6d4; --green: #5bd17a; --blue: #6aa8ff; --amber: #ffb24d; --red: #ff5f6e;
    --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    --label: 'Martian Mono', var(--mono);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    font: 13px/1.55 var(--mono); color: var(--text); background: var(--ink);
    padding: clamp(1rem, 3vw, 2.4rem); max-width: 78rem; margin: 0 auto;
    background-image:
      radial-gradient(1200px 620px at 88% -12%, rgba(70,230,212,.07), transparent 60%),
      radial-gradient(900px 540px at -8% 112%, rgba(106,168,255,.06), transparent 60%);
    background-attachment: fixed;
  }
  body::before {
    content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 50;
    background: repeating-linear-gradient(0deg, rgba(255,255,255,.018) 0 1px, transparent 1px 3px);
    mix-blend-mode: overlay; opacity: .6;
  }
  body.stale { filter: saturate(.4) brightness(.82); transition: filter .4s; }

  /* header */
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.4rem; }
  .brand { display: flex; align-items: center; gap: .7rem; }
  .glyph { color: var(--faint); flex: none; }
  .word { font-family: var(--label); font-weight: 700; font-size: 1.05rem; letter-spacing: -.01em; }
  .word b { color: var(--signal); font-weight: 700; }
  .tag { font-family: var(--label); font-size: .58rem; letter-spacing: .26em; text-transform: uppercase; color: var(--faint); padding-left: .7rem; border-left: 1px solid var(--line-2); }
  .cluster { display: flex; align-items: center; gap: .7rem; flex-wrap: wrap; }
  .live { display: inline-flex; align-items: center; gap: .5rem; font-family: var(--label); font-size: .62rem; letter-spacing: .2em; text-transform: uppercase; color: var(--muted); padding: .34rem .7rem; border: 1px solid var(--line); border-radius: 2rem; }
  .live .dot { width: .5rem; height: .5rem; border-radius: 50%; background: var(--faint); }
  .live[data-state="running"] { color: var(--signal); border-color: rgba(70,230,212,.4); }
  .live[data-state="running"] .dot { background: var(--signal); box-shadow: 0 0 0 0 rgba(70,230,212,.55); animation: pulse 1.6s infinite; }
  .live[data-state="paused"] { color: var(--amber); border-color: rgba(255,178,77,.35); }
  .live[data-state="paused"] .dot { background: var(--amber); }
  .live[data-state="done"] { color: var(--green); border-color: rgba(91,209,122,.35); }
  .live[data-state="done"] .dot { background: var(--green); }
  @keyframes pulse { to { box-shadow: 0 0 0 7px rgba(70,230,212,0); } }

  .chip { font-family: var(--mono); font-size: .72rem; padding: .3rem .6rem; border-radius: .35rem; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .gas[data-level="rising"] { color: var(--amber); border-color: rgba(255,178,77,.4); }
  .gas[data-level="spike"] { color: var(--red); border-color: rgba(255,95,110,.5); background: rgba(255,95,110,.06); }
  .gas[data-level="ok"] { color: var(--green); border-color: rgba(91,209,122,.3); }

  /* panels */
  main { display: flex; flex-direction: column; gap: 1rem; }
  .panel { position: relative; background: linear-gradient(180deg, var(--panel), #0b0d11); border: 1px solid var(--line); border-radius: .7rem; padding: 1.1rem 1.2rem; opacity: 0; transform: translateY(10px); animation: reveal .5s cubic-bezier(.2,.7,.2,1) forwards; }
  .panel::before, .panel::after { content: ''; position: absolute; width: 9px; height: 9px; border: 1px solid var(--line-2); pointer-events: none; }
  .panel::before { top: 7px; left: 7px; border-right: 0; border-bottom: 0; }
  .panel::after { bottom: 7px; right: 7px; border-left: 0; border-top: 0; }
  @keyframes reveal { to { opacity: 1; transform: none; } }
  .panel-h { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: .9rem; }
  .h-label { font-family: var(--label); font-size: .62rem; letter-spacing: .26em; text-transform: uppercase; color: var(--signal); }
  .h-meta { font-size: .72rem; color: var(--faint); font-variant-numeric: tabular-nums; }

  /* pipeline flow */
  .flow { display: flex; height: 12px; border-radius: 3px; overflow: hidden; background: rgba(255,255,255,.04); border: 1px solid var(--line); margin-bottom: .6rem; }
  .flow i { display: block; width: 0; transition: width .6s cubic-bezier(.2,.7,.2,1); }
  .seg.done { background: linear-gradient(var(--green), #43b863); }
  .seg.proc { background: linear-gradient(var(--signal), #2bbfb0); box-shadow: 0 0 12px rgba(70,230,212,.5); }
  .seg.pend { background: rgba(255,255,255,.09); }
  .seg.fail { background: linear-gradient(var(--red), #d6414f); }
  .legend { display: flex; gap: 1.1rem; flex-wrap: wrap; font-size: .64rem; color: var(--muted); letter-spacing: .04em; margin-bottom: 1.1rem; }
  .legend span { display: inline-flex; align-items: center; gap: .4rem; }
  .legend i { width: .55rem; height: .55rem; border-radius: 2px; }

  /* stat tiles */
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.2rem, 1fr)); gap: .55rem; }
  .tile { position: relative; padding: .75rem .85rem; border: 1px solid var(--line); border-radius: .5rem; background: rgba(255,255,255,.012); overflow: hidden; }
  .tile::after { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--accent, var(--faint)); opacity: .85; }
  .tile .k { font-family: var(--label); font-size: .54rem; letter-spacing: .2em; text-transform: uppercase; color: var(--muted); }
  .tile .v { font-family: var(--label); font-weight: 600; font-size: 1.55rem; line-height: 1.2; margin-top: .35rem; color: var(--text); font-variant-numeric: tabular-nums; transition: color .2s; }
  .tile[data-k="done"] { --accent: var(--green); } .tile[data-k="processing"] { --accent: var(--signal); }
  .tile[data-k="pending"] { --accent: var(--faint); } .tile[data-k="failed"] { --accent: var(--red); }
  .tile[data-k="aggregates"] { --accent: var(--blue); } .tile[data-k="parked"] { --accent: var(--amber); }
  .tile[data-k="workers"] { --accent: var(--signal); }
  .tile[data-k="failed"] .v { color: var(--red); }
  .v.hot { animation: hot .7s ease; }
  @keyframes hot { 0% { color: var(--signal); transform: translateY(-1px); } 100% { transform: none; } }

  /* controls */
  .controls { display: flex; gap: .55rem; flex-wrap: wrap; margin-top: 1.1rem; }
  .btn { font-family: var(--label); font-size: .62rem; letter-spacing: .14em; text-transform: uppercase; color: var(--text); padding: .55rem .95rem; border: 1px solid var(--line-2); border-radius: .45rem; background: rgba(255,255,255,.02); cursor: pointer; transition: border-color .15s, background .15s, transform .08s; }
  .btn:hover { border-color: var(--signal); color: var(--signal); }
  .btn:active, .btn.pressed { transform: translateY(1px); }
  .btn.primary { background: linear-gradient(180deg, rgba(70,230,212,.16), rgba(70,230,212,.06)); border-color: rgba(70,230,212,.55); color: var(--signal); }
  .btn.primary:hover { background: rgba(70,230,212,.22); }
  .btn:disabled { opacity: .3; cursor: not-allowed; transform: none; }
  .btn:disabled:hover { border-color: var(--line-2); color: var(--muted); }
  .btn.primary:disabled { background: rgba(255,255,255,.02); border-color: var(--line-2); color: var(--muted); }

  /* tables */
  .table-wrap { overflow-x: auto; }
  table.agg { border-collapse: collapse; width: 100%; }
  table.agg th { font-family: var(--label); font-size: .54rem; letter-spacing: .18em; text-transform: uppercase; color: var(--faint); text-align: left; font-weight: 400; padding: .35rem .6rem; border-bottom: 1px solid var(--line-2); }
  table.agg td { padding: .42rem .6rem; border-bottom: 1px solid var(--line); font-size: .78rem; }
  table.agg tr:hover td { background: rgba(255,255,255,.022); }
  td.num { font-variant-numeric: tabular-nums; color: var(--muted); }
  .stat { font-family: var(--label); font-size: .56rem; letter-spacing: .1em; text-transform: uppercase; padding: .2rem .5rem; border-radius: .3rem; border: 1px solid currentColor; white-space: nowrap; }
  .stat[data-status="planned"] { color: var(--faint); }
  .stat[data-status="submitted"] { color: var(--signal); }
  .stat[data-status="parked"] { color: var(--blue); }
  .stat[data-status~="unconfirmed"], .stat[data-status="add"] { color: var(--amber); }
  .stat[data-status="committed"] { color: var(--green); background: rgba(91,209,122,.08); }
  .stat[data-status="failed"] { color: var(--red); }
  .cid { font-family: var(--mono); font-size: .74rem; color: var(--text); cursor: pointer; border-bottom: 1px dotted var(--line-2); }
  .cid:hover { color: var(--signal); }
  .cid.copied { color: var(--green); border-color: var(--green); }

  /* fields + chips + fails */
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  textarea, input { font: inherit; width: 100%; padding: .6rem .7rem; border-radius: .45rem; border: 1px solid var(--line-2); background: var(--ink); color: var(--text); resize: vertical; }
  textarea::placeholder, input::placeholder { color: var(--faint); }
  textarea:focus, input:focus { outline: none; border-color: var(--signal); box-shadow: 0 0 0 3px rgba(70,230,212,.12); }
  .actions { display: flex; align-items: center; gap: .7rem; margin-top: .6rem; }
  .msg { font-size: .7rem; color: var(--green); }
  .chips { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .7rem; }
  .chip.gw { color: var(--muted); word-break: break-all; white-space: normal; }
  .fails { display: flex; flex-direction: column; gap: .4rem; }
  .fail { display: grid; grid-template-columns: minmax(8rem, auto) auto 1fr; align-items: center; gap: .6rem; padding: .4rem .55rem; border: 1px solid var(--line); border-left: 2px solid var(--red); border-radius: .4rem; background: rgba(255,95,110,.03); }
  .ferr { color: var(--red); font-size: .73rem; word-break: break-word; }
  .empty { color: var(--faint); font-size: .76rem; padding: .4rem .2rem; }

  /* next steps */
  .note { color: var(--muted); font-size: .76rem; line-height: 1.65; margin: 0 0 .9rem; }
  .note code { font-family: var(--mono); font-size: .72rem; color: var(--amber); }
  ol.steps { margin: 0; padding: 0; list-style: none; counter-reset: s; display: flex; flex-direction: column; gap: .55rem; }
  ol.steps li { display: flex; align-items: baseline; gap: .7rem; flex-wrap: wrap; counter-increment: s; }
  ol.steps li::before { content: counter(s); font-family: var(--label); font-size: .56rem; color: var(--signal); border: 1px solid var(--line-2); border-radius: .3rem; padding: .14rem .42rem; flex: none; }
  .cmd { font-family: var(--mono); font-size: .75rem; color: var(--text); background: var(--ink); border: 1px solid var(--line-2); border-radius: .35rem; padding: .34rem .55rem; cursor: pointer; word-break: break-all; transition: border-color .15s, color .15s; }
  .cmd:hover { border-color: var(--signal); color: var(--signal); }
  .cmd.copied { border-color: var(--green); color: var(--green); }
  .hint { color: var(--faint); font-size: .68rem; }

  /* footer */
  .foot { display: flex; gap: .7rem; flex-wrap: wrap; align-items: center; margin-top: 1.3rem; font-size: .68rem; color: var(--faint); letter-spacing: .04em; }
  .foot .sep { color: var(--line-2); }
  .foot #conn.ok { color: var(--green); } .foot #conn.bad { color: var(--amber); }
  .foot .err { color: var(--red); }

  @media (max-width: 720px) { .grid2 { grid-template-columns: 1fr; } .tag { display: none; } }
</style>
</head>
<body>
<header class="bar">
  <div class="brand">
    <svg class="glyph" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4.5" fill="none" stroke="currentColor" stroke-width="1.4" />
      <path d="M6 15l3.2-5.4 3 4.2 2-3 3.8-5" fill="none" stroke="#46e6d4" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span class="word">ipfs2<b>foc</b></span>
    <span class="tag">migration control</span>
  </div>
  <div class="cluster">
    <span class="live" id="live" data-state="idle"><i class="dot"></i><span id="state">connecting</span></span>
    <span class="chip gas" id="gas" data-level="off">base fee —</span>
  </div>
</header>

<main>
  <section class="panel" style="animation-delay:.04s">
    <div class="panel-h"><span class="h-label">pipeline</span><span class="h-meta" id="pieceTarget">piece target —</span></div>
    <div class="flow">
      <i class="seg done" id="seg-done"></i><i class="seg proc" id="seg-processing"></i><i class="seg pend" id="seg-pending"></i><i class="seg fail" id="seg-failed"></i>
    </div>
    <div class="legend">
      <span><i style="background:var(--green)"></i>done</span>
      <span><i style="background:var(--signal)"></i>processing</span>
      <span><i style="background:rgba(255,255,255,.18)"></i>pending</span>
      <span><i style="background:var(--red)"></i>failed</span>
    </div>
    <div class="tiles">
      <div class="tile" data-k="done"><div class="k">done</div><div class="v" id="t-done">0</div></div>
      <div class="tile" data-k="processing"><div class="k">processing</div><div class="v" id="t-processing">0</div></div>
      <div class="tile" data-k="pending"><div class="k">pending</div><div class="v" id="t-pending">0</div></div>
      <div class="tile" data-k="failed"><div class="k">failed</div><div class="v" id="t-failed">0</div></div>
      <div class="tile" data-k="aggregates"><div class="k">aggregates</div><div class="v" id="t-aggn">0</div></div>
      <div class="tile" data-k="parked"><div class="k">parked · uncommitted</div><div class="v" id="t-parked">0</div></div>
      <div class="tile" data-k="workers"><div class="k">workers</div><div class="v" id="t-active">0</div></div>
    </div>
    <div class="controls">
      <button class="btn primary" id="btn-start" onclick="act('start', this)">▸ Start</button>
      <button class="btn" id="btn-pause" onclick="act('pause', this)" disabled>❙❙ Pause</button>
      <button class="btn" id="btn-resume" onclick="act('resume', this)" disabled>▸ Resume</button>
      <button class="btn" id="btn-retry" onclick="act('retry', this)" disabled>⟳ Retry failed</button>
    </div>
  </section>

  <section class="panel" style="animation-delay:.11s">
    <div class="panel-h"><span class="h-label">aggregates</span><span class="h-meta" id="aggMeta">—</span></div>
    <div class="table-wrap">
      <table class="agg">
        <thead><tr><th>#</th><th>status</th><th>members</th><th>data set</th><th>piece</th><th>root pieceCID</th></tr></thead>
        <tbody id="aggs"></tbody>
      </table>
    </div>
    <div class="empty" id="aggEmpty">No aggregates planned yet. Add CIDs to begin.</div>
  </section>

  <section class="panel" id="nextSteps" style="display:none; animation-delay:.14s">
    <div class="panel-h"><span class="h-label">commit on chain</span><span class="h-meta" id="nextMeta"></span></div>
    <p class="note">This dashboard runs the commP + packing stage. Putting aggregates on chain is done from the CLI — those commands sign with <code>PRIVATE_KEY</code> and need a public HTTPS ingress. Default network is <code>mainnet</code>; add <code>--network calibration</code> for the testnet. Click a command to copy.</p>
    <ol class="steps" id="steps"></ol>
  </section>

  <div class="grid2">
    <section class="panel" style="animation-delay:.18s">
      <div class="panel-h"><span class="h-label">add cids</span></div>
      <textarea id="cids" rows="5" placeholder="bafy…&#10;Qm…&#10;(one CID per line)"></textarea>
      <div class="actions"><button class="btn" onclick="addCids()">Add CIDs</button><span class="msg" id="addMsg"></span></div>
    </section>
    <section class="panel" style="animation-delay:.24s">
      <div class="panel-h"><span class="h-label">gateways</span></div>
      <input id="gateways" placeholder="https://gateway.pinata.cloud, https://trustless-gateway.link" />
      <div class="actions"><button class="btn" onclick="setGateways()">Set gateways</button><span class="msg" id="gwMsg"></span></div>
      <div class="chips" id="gwList"></div>
    </section>
  </div>

  <section class="panel" style="animation-delay:.3s">
    <div class="panel-h"><span class="h-label">failures</span><span class="h-meta" id="failMeta">0</span></div>
    <div class="fails" id="fails"></div>
    <div class="empty" id="failEmpty">No failures.</div>
  </section>
</main>

<footer class="foot">
  <span id="conn" class="bad">● connecting</span>
  <span class="sep">/</span><span>polls every 2s</span>
  <span class="sep">/</span><span class="err" id="lastError"></span>
</footer>

<script>
function post(action, body, type) {
  const opts = { method: 'POST' }
  if (body != null) { opts.body = body; opts.headers = { 'content-type': type || 'text/plain' } }
  return fetch('/api/' + action, opts).then(function (r) { return r.json() })
}
function act(a, btn) {
  if (btn) btn.classList.add('pressed')
  post(a).then(function () { if (btn) setTimeout(function () { btn.classList.remove('pressed') }, 200); refresh() })
}
function addCids() {
  const el = document.getElementById('cids')
  post('cids', el.value).then(function (res) {
    document.getElementById('addMsg').textContent = 'added ' + res.added
    el.value = ''; refresh()
  })
}
function setGateways() {
  const text = document.getElementById('gateways').value
  post('gateways', JSON.stringify({ gateways: text.split(/[\\s,]+/).filter(Boolean) }), 'application/json').then(function (res) {
    document.getElementById('gwMsg').textContent = 'set ' + res.gateways.length; refresh()
  })
}
function esc(s) { return String(s).replace(/[<>&"']/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] }) }
function trunc(s) { s = String(s); return s.length > 30 ? s.slice(0, 14) + '…' + s.slice(-10) : s }
function fmtSize(b) { const n = Number(b); if (!n) return '—'; const g = n / 1073741824; return g >= 1 ? g.toFixed(0) + ' GiB' : (n / 1048576).toFixed(0) + ' MiB' }
function copyCid(el) { if (navigator.clipboard) navigator.clipboard.writeText(el.dataset.full).then(function () { el.classList.add('copied'); setTimeout(function () { el.classList.remove('copied') }, 900) }) }
function copyCmd(el) { if (navigator.clipboard) navigator.clipboard.writeText(el.dataset.cmd).then(function () { el.classList.add('copied'); setTimeout(function () { el.classList.remove('copied') }, 900) }) }
const prev = {}
function setNum(id, val) {
  const el = document.getElementById(id); if (!el) return
  const v = String(val)
  if (el.textContent !== v) { el.textContent = v; if (prev[id] !== undefined) { el.classList.remove('hot'); void el.offsetWidth; el.classList.add('hot') } }
  prev[id] = v
}
function refresh() {
  fetch('/api/status').then(function (r) { return r.json() }).then(function (s) {
    document.body.classList.remove('stale')
    const cn = document.getElementById('conn'); cn.textContent = '● connected'; cn.className = 'ok'
    const c = s.counts, total = (c.done + c.processing + c.pending + c.failed) || 1
    const st = String(s.state || 'idle')
    document.getElementById('state').textContent = st
    document.getElementById('live').dataset.state = st
    const running = st === 'running', paused = st === 'paused'
    document.getElementById('btn-start').disabled = running || paused || c.pending <= 0
    document.getElementById('btn-pause').disabled = !running
    document.getElementById('btn-resume').disabled = !paused
    document.getElementById('btn-retry').disabled = c.failed <= 0
    document.getElementById('pieceTarget').textContent = 'piece target ' + fmtSize(s.aggregateSizeBytes)
    document.getElementById('seg-done').style.width = (100 * c.done / total) + '%'
    document.getElementById('seg-processing').style.width = (100 * c.processing / total) + '%'
    document.getElementById('seg-pending').style.width = (100 * c.pending / total) + '%'
    document.getElementById('seg-failed').style.width = (100 * c.failed / total) + '%'
    setNum('t-done', c.done); setNum('t-processing', c.processing); setNum('t-pending', c.pending); setNum('t-failed', c.failed)
    setNum('t-aggn', s.aggregates.length)
    const parked = s.aggregates.filter(function (a) { return a.status === 'submitted' || a.status === 'parked' || a.status === 'add_unconfirmed' }).length
    setNum('t-parked', parked); setNum('t-active', s.active)
    const committed = s.aggregates.filter(function (a) { return a.status === 'committed' }).length
    document.getElementById('aggMeta').textContent = s.aggregates.length ? committed + ' committed · ' + s.aggregates.length + ' total' : '—'
    const g = document.getElementById('gas')
    if (s.gas) { g.textContent = 'base fee ' + s.gas.baseFee + ' · ' + s.gas.multipleOfFloor + '× · ' + (s.gas.pause ? 'SPIKE — pause' : s.gas.level); g.dataset.level = s.gas.pause ? 'spike' : s.gas.level; g.title = '' }
    else { g.textContent = 'base fee · off'; g.dataset.level = 'off'; g.title = 'base-fee monitor is off — start serve with --network or --rpc-url to enable' }
    document.getElementById('lastError').textContent = s.lastError ? ('last error · ' + s.lastError) : ''
    document.getElementById('gwList').innerHTML = s.gateways.map(function (x) { return '<span class="chip gw">' + esc(x) + '</span>' }).join('')
    const aggs = s.aggregates.map(function (a) {
      const ds = a.dataSetId != null ? esc(a.dataSetId) : '—'
      const pid = a.pieceId != null ? esc(a.pieceId) : '—'
      return '<tr><td class="num">' + a.idx + '</td>' +
        '<td><span class="stat" data-status="' + esc(a.status) + '">' + esc(String(a.status).replace(/_/g, ' ')) + '</span></td>' +
        '<td class="num">' + a.memberCount + '</td><td class="num">' + ds + '</td><td class="num">' + pid + '</td>' +
        '<td><span class="cid" data-full="' + esc(a.rootPieceCid) + '" title="' + esc(a.rootPieceCid) + '" onclick="copyCid(this)">' + esc(trunc(a.rootPieceCid)) + '</span></td></tr>'
    }).join('')
    document.getElementById('aggs').innerHTML = aggs
    document.getElementById('aggEmpty').style.display = s.aggregates.length ? 'none' : 'block'
    const db = s.dbPath || 'migrate.db'
    const toCommit = s.aggregates.filter(function (a) { return a.status !== 'committed' && a.status !== 'failed' }).length
    const ns = document.getElementById('nextSteps')
    if (toCommit > 0) {
      ns.style.display = ''
      document.getElementById('nextMeta').textContent = toCommit + ' aggregate(s) to commit'
      const cmds = [
        ['ipfs2foc create-data-set --provider-id <id>', 'once per provider · skip if reusing a data set'],
        ['ipfs2foc redirect-serve --db ' + db + ' --ingress cloudflared --port 4322', 'terminal A · leave running'],
        ['ipfs2foc pdp-submit --db ' + db + ' --data-set-id <id> --source-base https://<host>', 'terminal B'],
        ['ipfs2foc report --db ' + db + ' --data-set-id <id>', 'confirm on chain']
      ]
      document.getElementById('steps').innerHTML = cmds.map(function (p) {
        return '<li><span class="cmd" data-cmd="' + esc(p[0]) + '" title="click to copy" onclick="copyCmd(this)">' + esc(p[0]) + '</span><em class="hint">' + esc(p[1]) + '</em></li>'
      }).join('')
    } else {
      ns.style.display = 'none'
    }
    const fl = s.failures || []
    document.getElementById('failMeta').textContent = fl.length
    document.getElementById('fails').innerHTML = fl.map(function (f) {
      const cat = f.category ? '<span class="stat" data-status="failed">' + esc(f.category) + '</span>' : '<span></span>'
      return '<div class="fail"><span class="cid" data-full="' + esc(f.cid) + '" title="' + esc(f.cid) + '" onclick="copyCid(this)">' + esc(trunc(f.cid)) + '</span>' + cat + '<span class="ferr">' + esc(f.error) + '</span></div>'
    }).join('')
    document.getElementById('failEmpty').style.display = fl.length ? 'none' : 'block'
  }).catch(function () {
    document.body.classList.add('stale')
    const cn = document.getElementById('conn'); cn.textContent = '● reconnecting'; cn.className = 'bad'
  })
}
refresh(); setInterval(refresh, 2000)
</script>
</body>
</html>`
