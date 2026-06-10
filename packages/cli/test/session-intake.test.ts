import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'
import { Runner } from '../src/runner.ts'
import { type ServeOptions, startServer } from '../src/server.ts'
import { sessionAddressOf } from '../src/session-submit.ts'

// The /api/session intake is the trust boundary of browser-signed submission:
// the daemon must reject foreign networks, verify the grant on chain (not the
// claimed expiry), derive the session address from the key itself, persist
// before acknowledging, and never let the key out again in any response.

const KEY = `0x${'11'.repeat(32)}` as const
const ROOT = `0x${'22'.repeat(20)}` as const
const FUTURE = BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400)

async function harness(overrides: Partial<ServeOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'foc-session-'))
  const appDir = join(dir, 'app')
  await mkdir(appDir, { recursive: true })
  await writeFile(join(appDir, 'index.html'), '<!doctype html>')
  const db = new MigrationDB(join(dir, 'migrate.db'))
  const runner = new Runner(db, { gateways: ['https://gw.example'], concurrency: 1, aggregateSizeBytes: 1024n })
  const server: Server = await startServer({
    db,
    runner,
    port: 0,
    network: 'calibration',
    appDir,
    submit: { rpcUrl: 'http://rpc.invalid', maxBaseFee: 0n },
    sessionValidator: async () => FUTURE,
    ...overrides,
  })
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
  return { base, close, db }
}

function postSession(base: string, body: unknown) {
  return fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('a valid session is verified on chain, persisted before the ack, and echoed without the key', async () => {
  const h = await harness({
    sessionValidator: async (_rpc, _net, ids) => {
      assert.equal(ids.root, ROOT)
      assert.equal(ids.sessionAddress, sessionAddressOf(KEY))
      return FUTURE
    },
  })
  try {
    const res = await postSession(h.base, { sessionPrivateKey: KEY, root: ROOT, chainId: 314159 })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.sessionAddress, sessionAddressOf(KEY))
    assert.equal(body.expiresAt, Number(FUTURE))
    assert.ok(!JSON.stringify(body).includes(KEY.slice(2)))
    const row = h.db.loadSessionKey()
    assert.ok(row != null)
    assert.equal(row.privateKey, KEY)
    assert.equal(row.expiresAt, Number(FUTURE)) // validator's value, not a body claim
  } finally {
    await h.close()
  }
})

test('chainId mismatch is rejected before any chain read', async () => {
  const h = await harness({
    sessionValidator: async () => {
      throw new Error('must not be called')
    },
  })
  try {
    const res = await postSession(h.base, { sessionPrivateKey: KEY, root: ROOT, chainId: 314 })
    assert.equal(res.status, 409)
    assert.equal((await res.json()).reason, 'network-mismatch')
    assert.equal(h.db.loadSessionKey(), null)
  } finally {
    await h.close()
  }
})

test('a grant the chain does not know is rejected and not persisted', async () => {
  const h = await harness({ sessionValidator: async () => 0n })
  try {
    const res = await postSession(h.base, { sessionPrivateKey: KEY, root: ROOT, chainId: 314159 })
    assert.equal(res.status, 422)
    assert.equal((await res.json()).reason, 'not-authorized')
    assert.equal(h.db.loadSessionKey(), null)
  } finally {
    await h.close()
  }
})

test('an expired grant is rejected with its own reason', async () => {
  const h = await harness({ sessionValidator: async () => BigInt(Math.floor(Date.now() / 1000) - 60) })
  try {
    const res = await postSession(h.base, { sessionPrivateKey: KEY, root: ROOT, chainId: 314159 })
    assert.equal(res.status, 422)
    assert.equal((await res.json()).reason, 'expired')
  } finally {
    await h.close()
  }
})

test('malformed bodies are 400 without echoing content', async () => {
  const h = await harness()
  try {
    const badJson = await fetch(`${h.base}/api/session`, { method: 'POST', body: `{"sessionPrivateKey": "${KEY}"` })
    assert.equal(badJson.status, 400)
    assert.ok(!(await badJson.text()).includes(KEY.slice(2)))
    const badKey = await postSession(h.base, { sessionPrivateKey: '0xnope', root: ROOT, chainId: 314159 })
    assert.equal(badKey.status, 400)
    const badRoot = await postSession(h.base, { sessionPrivateKey: KEY, root: 'someone', chainId: 314159 })
    assert.equal(badRoot.status, 400)
  } finally {
    await h.close()
  }
})

test('re-POST upserts the single session row; DELETE forgets it', async () => {
  const h = await harness()
  try {
    await postSession(h.base, { sessionPrivateKey: KEY, root: ROOT, chainId: 314159 })
    const otherKey = `0x${'33'.repeat(32)}`
    const res = await postSession(h.base, { sessionPrivateKey: otherKey, root: ROOT, chainId: 314159 })
    assert.equal(res.status, 200)
    assert.equal(h.db.loadSessionKey()?.sessionAddress, sessionAddressOf(otherKey))

    const del = await fetch(`${h.base}/api/session`, { method: 'DELETE' })
    assert.equal(del.status, 200)
    assert.equal(h.db.loadSessionKey(), null)
    const after = await (await fetch(`${h.base}/api/session`)).json()
    assert.deepEqual(after, { present: false })
  } finally {
    await h.close()
  }
})

test('status and session responses never carry the private key', async () => {
  const h = await harness()
  try {
    await postSession(h.base, { sessionPrivateKey: KEY, root: ROOT, chainId: 314159 })
    const status = await (await fetch(`${h.base}/api/status`)).text()
    assert.ok(!status.includes(KEY.slice(2)))
    assert.match(status, /"session":\{"present":true/)
    const session = await (await fetch(`${h.base}/api/session`)).text()
    assert.ok(!session.includes(KEY.slice(2)))
  } finally {
    await h.close()
  }
})

test('cross-origin DELETE is rejected like POST', async () => {
  const h = await harness()
  try {
    const res = await fetch(`${h.base}/api/session`, {
      method: 'DELETE',
      headers: { origin: 'http://evil.example' },
    })
    assert.equal(res.status, 403)
  } finally {
    await h.close()
  }
})
