import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'
import { makeRedirectHandler } from '../src/redirect-server.ts'

// The redirect server is what the storage provider's pull actually hits:
// passthrough sub-pieces 302 to the gateway CAR; assembled sub-pieces stream the
// CAR file with Content-Length; everything else is 404. A length-drift on an
// assembled file must fail loudly rather than serve a truncated pull.

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'foc-redirect-'))
  const db = new MigrationDB(join(dir, 'migrate.db'))
  const server = createServer(makeRedirectHandler(db))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
  return { dir, db, base, close, server: server as Server }
}

test('healthz returns 200 ok', async () => {
  const h = await harness()
  try {
    const res = await fetch(`${h.base}/healthz`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'ok')
  } finally {
    await h.close()
  }
})

test('passthrough sub-piece 302s to the gateway CAR URL', async () => {
  const h = await harness()
  try {
    h.db.addCids(['bafSrc'])
    h.db.recordPieceSuccess('bafSrc', 'pcPass', 100, 'g', 'https://gw.example/ipfs/bafSrc?format=car', 'sha')
    h.db.recordPassthroughSubPiece({
      subPieceCid: 'pcPass',
      sourceCid: 'bafSrc',
      url: 'https://gw.example/ipfs/bafSrc?format=car',
      rawSize: 100,
      memberSha256: null,
    })
    const res = await fetch(`${h.base}/piece/pcPass`, { redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), 'https://gw.example/ipfs/bafSrc?format=car')
    assert.equal(res.headers.get('cache-control'), 'no-store')
  } finally {
    await h.close()
  }
})

test('assembled sub-piece streams the CAR file with Content-Length', async () => {
  const h = await harness()
  try {
    const carPath = join(h.dir, 'assembled.car')
    const bytes = Buffer.from('CARv1-ish bytes for the assembled sub-piece')
    await writeFile(carPath, bytes)
    h.db.addCids(['bafA'])
    h.db.recordPieceSuccess('bafA', 'pcA', bytes.length, 'g', 'u', 'shaA')
    h.db.recordBuiltSubPiece({
      subPieceCid: 'pcAsm',
      assembledCarLength: bytes.length,
      targetSizeBytes: 256,
      carPath,
      assembledSha256: 'sha-asm',
      members: [{ cid: 'bafA', rawSize: bytes.length, sha256: 'shaA' }],
    })
    const res = await fetch(`${h.base}/piece/pcAsm`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/vnd.ipld.car')
    assert.equal(res.headers.get('content-length'), String(bytes.length))
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes)
  } finally {
    await h.close()
  }
})

test('assembled sub-piece with a length drift fails with 500 (no truncated pull)', async () => {
  const h = await harness()
  try {
    const carPath = join(h.dir, 'short.car')
    const bytes = Buffer.from('only 20 bytes here..')
    await writeFile(carPath, bytes)
    h.db.addCids(['bafB'])
    h.db.recordPieceSuccess('bafB', 'pcB', bytes.length, 'g', 'u', 'shaB')
    h.db.recordBuiltSubPiece({
      subPieceCid: 'pcDrift',
      assembledCarLength: bytes.length + 999, // planned length != on-disk
      targetSizeBytes: 256,
      carPath,
      assembledSha256: 'sha-b',
      members: [{ cid: 'bafB', rawSize: bytes.length, sha256: 'shaB' }],
    })
    const res = await fetch(`${h.base}/piece/pcDrift`)
    assert.equal(res.status, 500)
    assert.match(await res.text(), /length drift/)
  } finally {
    await h.close()
  }
})

test('unknown piece is 404; non-GET is 404', async () => {
  const h = await harness()
  try {
    const unknown = await fetch(`${h.base}/piece/pcNope`)
    assert.equal(unknown.status, 404)
    const post = await fetch(`${h.base}/piece/pcNope`, { method: 'POST' })
    assert.equal(post.status, 404)
  } finally {
    await h.close()
  }
})
