import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'

test('concurrent MigrationDB writes do not error with SQLITE_BUSY', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foc-db-concurrent-'))
  const path = join(dir, 'migrate.db')
  try {
    const a = new MigrationDB(path)
    const b = new MigrationDB(path)
    // Seed one piece row through `a` so the schema is materialised; both
    // connections then race to mutate it.
    a.recordPieceSuccess(
      'bafkreia5wnkvwifodgqmkgyjgdtz77xpibnq25rnsqccq6nxbpmyc5fqoi',
      'bafkzcibe2wiqcdjy7lq3dgv54ketriu5l3vfsuyclrzu5geapxmsux5pyqokfgywgm',
      100,
      'g',
      'u',
      'd7e2a92c824bae07'
    )
    const errors: unknown[] = []
    const updaterA = (async () => {
      for (let i = 0; i < 200; i++) {
        try {
          a.recordPieceFailure(
            'bafkreia5wnkvwifodgqmkgyjgdtz77xpibnq25rnsqccq6nxbpmyc5fqoi',
            `e-${i}`,
            'source_gateway_5xx'
          )
        } catch (err) {
          errors.push(err)
          break
        }
      }
    })()
    const updaterB = (async () => {
      for (let i = 0; i < 200; i++) {
        try {
          b.failures()
        } catch (err) {
          errors.push(err)
          break
        }
      }
    })()
    await Promise.all([updaterA, updaterB])
    a.close()
    b.close()
    assert.deepEqual(errors, [], `unexpected errors: ${errors.map(String).join('; ')}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('MigrationDB leaves the journal in WAL mode on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foc-db-pragma-'))
  const path = join(dir, 'migrate.db')
  try {
    const m = new MigrationDB(path)
    m.close()
    // journal_mode persists in the file header; a sibling connection reading
    // it back observes WAL even though busy_timeout is per-connection.
    const peer = new DatabaseSync(path)
    const mode = peer.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    assert.equal(mode.journal_mode, 'wal')
    peer.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
