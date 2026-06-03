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
<title>ipfs2foc</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 60rem; }
  h1 { font-size: 1.2rem; margin: 0 0 1rem; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin: .5rem 0; }
  .pill { padding: .15rem .6rem; border-radius: 1rem; background: #8883; font-variant-numeric: tabular-nums; }
  .state { font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  button { font: inherit; padding: .35rem .8rem; border-radius: .4rem; border: 1px solid #8886; background: #8881; cursor: pointer; }
  button:hover { background: #8883; }
  .bar { height: .6rem; border-radius: .3rem; background: #8883; overflow: hidden; margin: .5rem 0; }
  .bar > i { display: block; height: 100%; background: #2a8; transition: width .4s; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; font-size: 13px; }
  th, td { text-align: left; padding: .25rem .5rem; border-bottom: 1px solid #8883; font-variant-numeric: tabular-nums; }
  code { font-size: 12px; word-break: break-all; }
  textarea, input { font: inherit; width: 100%; box-sizing: border-box; padding: .4rem; border-radius: .4rem; border: 1px solid #8886; background: transparent; color: inherit; }
  details { margin-top: 1rem; } summary { cursor: pointer; }
  .err { color: #c33; }
</style>
</head>
<body>
<h1>ipfs2foc dashboard</h1>

<div class="row">
  <span class="state pill" id="state">…</span>
  <button onclick="post('start')">Start</button>
  <button onclick="post('pause')">Pause</button>
  <button onclick="post('resume')">Resume</button>
  <button onclick="post('retry')">Retry failed</button>
</div>

<div class="bar"><i id="prog" style="width:0%"></i></div>
<div class="row">
  <span class="pill">done <b id="done">0</b></span>
  <span class="pill">processing <b id="processing">0</b></span>
  <span class="pill">pending <b id="pending">0</b></span>
  <span class="pill err">failed <b id="failed">0</b></span>
  <span class="pill">aggregates <b id="aggn">0</b></span>
  <span class="pill">parked uncommitted <b id="parked">0</b></span>
  <span class="pill">workers <b id="active">0</b></span>
  <span class="pill" id="gas">baseFee —</span>
</div>
<div class="err" id="lastError"></div>

<details open>
  <summary>Add CIDs (paste, one per line)</summary>
  <textarea id="cids" rows="4" placeholder="bafy…&#10;Qm…"></textarea>
  <div class="row"><button onclick="addCids()">Add CIDs</button> <span id="addMsg"></span></div>
</details>

<details>
  <summary>Gateways</summary>
  <input id="gateways" placeholder="https://gateway.pinata.cloud, https://trustless-gateway.link" />
  <div class="row"><button onclick="setGateways()">Set gateways</button> <span id="gwMsg"></span></div>
  <div id="gwList" class="row"></div>
</details>

<h2 style="font-size:1rem">Aggregates</h2>
<table><thead><tr><th>#</th><th>status</th><th>members</th><th>data set</th><th>piece</th><th>root pieceCID (parent)</th></tr></thead><tbody id="aggs"></tbody></table>

<details>
  <summary>Failures</summary>
  <table><tbody id="fails"></tbody></table>
</details>

<script>
async function post(action, body, type) {
  const opts = { method: 'POST' }
  if (body != null) { opts.body = body; opts.headers = { 'content-type': type || 'text/plain' } }
  const r = await fetch('/api/' + action, opts)
  return r.json()
}
async function addCids() {
  const text = document.getElementById('cids').value
  const res = await post('cids', text)
  document.getElementById('addMsg').textContent = 'added ' + res.added
  document.getElementById('cids').value = ''
  refresh()
}
async function setGateways() {
  const text = document.getElementById('gateways').value
  const res = await post('gateways', JSON.stringify({ gateways: text.split(/[\\s,]+/).filter(Boolean) }), 'application/json')
  document.getElementById('gwMsg').textContent = 'set ' + res.gateways.length
  refresh()
}
function esc(s) { return String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) }
async function refresh() {
  let s; try { s = await (await fetch('/api/status')).json() } catch { return }
  const c = s.counts, total = c.done + c.processing + c.pending + c.failed || 1
  document.getElementById('state').textContent = s.state
  document.getElementById('prog').style.width = (100 * c.done / total) + '%'
  for (const k of ['done','processing','pending','failed']) document.getElementById(k).textContent = c[k]
  document.getElementById('aggn').textContent = s.aggregates.length
  document.getElementById('parked').textContent = s.aggregates.filter(a => a.status === 'submitted' || a.status === 'parked').length
  document.getElementById('active').textContent = s.active
  const gasEl = document.getElementById('gas')
  if (s.gas) {
    gasEl.textContent = 'baseFee ' + s.gas.baseFee + ' (' + s.gas.multipleOfFloor + 'x) ' + (s.gas.pause ? 'SPIKE — pause' : s.gas.level)
    gasEl.style.background = s.gas.pause ? '#c333' : s.gas.level === 'rising' ? '#ca33' : '#8883'
  } else {
    gasEl.textContent = 'baseFee —'
  }
  document.getElementById('lastError').textContent = s.lastError ? ('last error — ' + s.lastError) : ''
  document.getElementById('gwList').innerHTML = s.gateways.map(g => '<span class="pill">' + esc(g) + '</span>').join('')
  document.getElementById('aggs').innerHTML = s.aggregates.map(a =>
    '<tr><td>' + a.idx + '</td><td>' + a.status + '</td><td>' + a.memberCount + '</td><td>' +
    esc(a.dataSetId || '—') + '</td><td>' + esc(a.pieceId || '—') + '</td><td><code>' + esc(a.rootPieceCid) + '</code></td></tr>').join('')
  document.getElementById('fails').innerHTML = s.failures.map(f =>
    '<tr><td><code>' + esc(f.cid) + '</code></td><td class="err">' + esc(f.error) + '</td></tr>').join('')
}
refresh(); setInterval(refresh, 2000);
</script>
</body>
</html>`
