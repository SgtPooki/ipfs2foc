import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'
import { Runner } from '../src/runner.ts'
import { type IngressState, type ServeOptions, startServer } from '../src/server.ts'
import { sessionAddressOf } from '../src/session-submit.ts'
import type { runSubmitPdp } from '../src/submit-pdp.ts'

// POST /api/submit is gated, in order: configured signing, a free job slot, a
// stored session outside the presign margin, and a public ingress that
// answers a FRESH probe (a provider pull against a dead tunnel fails
// silently). Only then does the daemon start the background submit run with
// session-key deps.

const KEY = `0x${'11'.repeat(32)}` as const
const ROOT = `0x${'22'.repeat(20)}` as const
const FUTURE = Math.floor(Date.now() / 1000) + 7 * 86_400

type Driver = typeof runSubmitPdp

async function harness(opts: {
  session?: boolean
  expiresAt?: number
  ingress?: IngressState
  probe?: (base: string) => Promise<boolean>
  driver?: Driver
  overrides?: Partial<ServeOptions>
}) {
  const dir = await mkdtemp(join(tmpdir(), 'foc-submit-'))
  const appDir = join(dir, 'app')
  await mkdir(appDir, { recursive: true })
  await writeFile(join(appDir, 'index.html'), '<!doctype html>')
  const db = new MigrationDB(join(dir, 'migrate.db'))
  if (opts.session !== false) {
    db.saveSessionKey({
      chainId: 314159,
      rootAddress: ROOT,
      sessionAddress: sessionAddressOf(KEY),
      privateKey: KEY,
      expiresAt: opts.expiresAt ?? FUTURE,
    })
  }
  const runner = new Runner(db, { gateways: ['https://gw.example'], concurrency: 1, aggregateSizeBytes: 1024n })
  const ingress = opts.ingress ?? { publicBase: 'https://pub.example', reachable: true }
  const server: Server = await startServer({
    db,
    runner,
    port: 0,
    network: 'calibration',
    appDir,
    ingress,
    submit: { rpcUrl: 'http://rpc.invalid', maxBaseFee: 7n },
    probe: opts.probe ?? (async () => true),
    submitDriver: opts.driver ?? (async () => {}),
    ...opts.overrides,
  })
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
  return { base, close, db, ingress }
}

function postSubmit(base: string, body: unknown = { dataSetId: 42 }) {
  return fetch(`${base}/api/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('submit without a session is refused', async () => {
  const h = await harness({ session: false })
  try {
    const res = await postSubmit(h.base)
    assert.equal(res.status, 409)
    assert.equal((await res.json()).reason, 'no-session')
  } finally {
    await h.close()
  }
})

test('a session inside the presign margin is refused before any probe', async () => {
  const h = await harness({
    expiresAt: Math.floor(Date.now() / 1000) + 600, // 10 min < 1h margin
    probe: async () => {
      throw new Error('must not probe')
    },
  })
  try {
    const res = await postSubmit(h.base)
    assert.equal(res.status, 409)
    assert.equal((await res.json()).reason, 'session-margin')
  } finally {
    await h.close()
  }
})

test('missing or unreachable ingress is refused with a fresh probe', async () => {
  const noBase = await harness({ ingress: { publicBase: null, reachable: null } })
  try {
    const res = await postSubmit(noBase.base)
    assert.equal(res.status, 409)
    assert.equal((await res.json()).reason, 'ingress-unreachable')
  } finally {
    await noBase.close()
  }

  // A stale reachable=true must not be trusted: the submit-time probe decides.
  const deadTunnel = await harness({
    ingress: { publicBase: 'https://pub.example', reachable: true },
    probe: async () => false,
  })
  try {
    const res = await postSubmit(deadTunnel.base)
    assert.equal(res.status, 409)
    assert.equal((await res.json()).reason, 'ingress-unreachable')
    assert.equal(deadTunnel.ingress.reachable, false) // cell updated with the probe result
  } finally {
    await deadTunnel.close()
  }
})

test('a running job refuses a second submit, then frees the slot', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const h = await harness({ driver: () => gate })
  try {
    const first = await postSubmit(h.base)
    assert.equal(first.status, 202)
    const second = await postSubmit(h.base)
    assert.equal(second.status, 409)
    assert.equal((await second.json()).reason, 'job-running')

    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const status = await (await fetch(`${h.base}/api/status`)).json()
    assert.equal(status.submit.running, false)
    assert.equal(status.submit.dataSetId, 42)
    assert.equal(status.submit.lastError, null)
  } finally {
    await h.close()
  }
})

test('the driver gets the public base as sourceBase and session deps', async () => {
  let captured: { opts?: Parameters<Driver>[1]; deps?: Parameters<Driver>[2] } = {}
  const h = await harness({
    driver: async (_db, opts, deps) => {
      captured = { opts, deps }
    },
  })
  try {
    const res = await postSubmit(h.base, { dataSetId: 7 })
    assert.equal(res.status, 202)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(captured.opts?.sourceBase, 'https://pub.example')
    assert.equal(captured.opts?.dataSetId, 7)
    assert.equal(captured.opts?.network, 'calibration')
    assert.equal(captured.opts?.maxBaseFee, 7n)
    assert.equal(captured.opts?.privateKey, undefined) // session deps sign, not PRIVATE_KEY
    assert.ok(captured.deps != null)
  } finally {
    await h.close()
  }
})

test('a failing run surfaces lastError in status without crashing the daemon', async () => {
  const h = await harness({
    driver: async () => {
      throw new Error('provider rejected the pull')
    },
  })
  try {
    assert.equal((await postSubmit(h.base)).status, 202)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const status = await (await fetch(`${h.base}/api/status`)).json()
    assert.equal(status.submit.running, false)
    assert.match(status.submit.lastError, /provider rejected/)
    // The daemon still answers; a later submit can retry.
    assert.equal((await postSubmit(h.base)).status, 202)
  } finally {
    await h.close()
  }
})

test('create-data-set shares the job slot and reports its result', async () => {
  const h = await harness({})
  try {
    // No real chain here: the createDataSet call fails fast against the fake
    // RPC, which is exactly what the job error path should surface.
    const res = await fetch(`${h.base}/api/data-sets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 3 }),
    })
    assert.equal(res.status, 202)
    // viem retries the dead RPC with backoff before the job settles.
    let status: { submit: { kind: string; running: boolean; lastError: string | null } } | null = null
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      status = await (await fetch(`${h.base}/api/status`)).json()
      if (status?.submit.running === false) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.equal(status?.submit.kind, 'create-data-set')
    assert.equal(status?.submit.running, false)
    assert.ok(status?.submit.lastError != null)
  } finally {
    await h.close()
  }
})
