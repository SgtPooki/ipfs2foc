import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'
import { guardedPresignContext, SessionMarginError } from '../src/session-submit.ts'

// Presigns are consumed by the provider on-chain LATER, so none may be issued
// inside the safety margin — but the chain is canonical for expiry: a session
// the operator extended in the browser mid-run must keep a live run going
// without any re-handover, and only a genuinely expiring grant may block.

const now = () => Math.floor(Date.now() / 1000)

async function harness(expiresAt: number) {
  const dir = await mkdtemp(join(tmpdir(), 'foc-margin-'))
  const db = new MigrationDB(join(dir, 'migrate.db'))
  const session = {
    chainId: 314159,
    rootAddress: `0x${'22'.repeat(20)}`,
    sessionAddress: `0x${'33'.repeat(20)}`,
    privateKey: `0x${'11'.repeat(32)}`,
    expiresAt,
  }
  db.saveSessionKey(session)
  const close = async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
  return { db, session, close }
}

test('a healthy session presigns without touching the chain', async () => {
  const h = await harness(now() + 86_400)
  try {
    let presigns = 0
    let validations = 0
    const ctx = guardedPresignContext(
      h.db,
      h.session,
      {
        presignForCommit: async () => {
          presigns++
          return '0xsigned'
        },
      },
      'http://rpc.invalid',
      'calibration',
      async () => {
        validations++
        return 0n
      }
    )
    assert.equal(await ctx.presignForCommit([]), '0xsigned')
    assert.equal(presigns, 1)
    assert.equal(validations, 0)
  } finally {
    await h.close()
  }
})

test('inside the margin, a browser-side extend un-blocks the run via the chain', async () => {
  const h = await harness(now() + 600) // 10 min left — inside the 1h margin
  try {
    const extended = BigInt(now() + 3 * 86_400)
    let presigns = 0
    const ctx = guardedPresignContext(
      h.db,
      h.session,
      {
        presignForCommit: async () => {
          presigns++
          return '0xsigned'
        },
      },
      'http://rpc.invalid',
      'calibration',
      async () => extended
    )
    assert.equal(await ctx.presignForCommit([]), '0xsigned')
    assert.equal(presigns, 1)
    // The refreshed expiry is persisted, so status and later gates see it.
    assert.equal(h.db.loadSessionKey()?.expiresAt, Number(extended))
    // And the next presign trusts the refreshed cache — no second chain read.
    const validations = 0
    await ctx.presignForCommit([])
    assert.equal(validations, 0)
  } finally {
    await h.close()
  }
})

test('a genuinely expiring session blocks with a resumable error and no presign', async () => {
  const stillExpiring = now() + 600
  const h = await harness(stillExpiring)
  try {
    let presigns = 0
    const ctx = guardedPresignContext(
      h.db,
      h.session,
      {
        presignForCommit: async () => {
          presigns++
          return '0xsigned'
        },
      },
      'http://rpc.invalid',
      'calibration',
      async () => BigInt(stillExpiring) // chain agrees: not extended
    )
    await assert.rejects(() => ctx.presignForCommit([]), SessionMarginError)
    assert.equal(presigns, 0)
  } finally {
    await h.close()
  }
})
