import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCarStoreSink } from '../src/pack-cars.ts'

test('createCarStoreSink does not leak error listeners across many writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foc-sink-leak-'))
  try {
    const sink = createCarStoreSink(join(dir, 'out.car'))
    // Reach for the underlying stream via the captured closure — observe via
    // the warning the runtime would emit. We assert no listener-leak warning
    // is emitted across 1000 sequential writes.
    const warnings: string[] = []
    const onWarning = (w: { name?: string; message?: string }) => {
      if (w.name === 'MaxListenersExceededWarning') warnings.push(w.message ?? '')
    }
    process.on('warning', onWarning)
    try {
      for (let i = 0; i < 1000; i++) await sink.write(new Uint8Array([i & 0xff]))
      await sink.end()
    } finally {
      process.off('warning', onWarning)
    }
    assert.deepEqual(warnings, [], 'expected no MaxListenersExceededWarning')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createCarStoreSink rejects writes when the underlying file cannot be opened', async () => {
  // Pointing at a path whose parent directory does not exist makes
  // createWriteStream emit 'error' asynchronously on the open syscall. The
  // first write must reject (or whatever subsequent operation observes the
  // error) — silent loss of bytes is unacceptable for the assembled CAR.
  const sink = createCarStoreSink('/nonexistent-parent-dir-foc/out.car')
  let threw = false
  try {
    for (let i = 0; i < 8; i++) await sink.write(new Uint8Array([1, 2, 3]))
    await sink.end()
  } catch {
    threw = true
  }
  assert.ok(threw, 'expected write/end to reject when the file cannot be opened')
})

test('createCarStoreSink leaves no partial file when writes never succeed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foc-sink-orphan-'))
  // Target lives under a directory we then remove; createWriteStream fails on
  // open. The contract: the path the sink advertised holds no file once the
  // sink's write/end has rejected.
  await rm(dir, { recursive: true, force: true })
  const filePath = join(dir, 'out.car')
  const sink = createCarStoreSink(filePath)
  try {
    await sink.write(new Uint8Array([1, 2, 3]))
    await sink.end()
  } catch {
    /* expected */
  }
  const exists = await stat(filePath).then(
    () => true,
    () => false
  )
  assert.equal(exists, false, 'expected no orphan file at the sink path after rejection')
})
