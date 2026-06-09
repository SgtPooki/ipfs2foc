/**
 * Coverage for the pure helpers in src/analyze.ts: persona matching and the
 * cache-mode heuristic. The network-touching paths are exercised in manual
 * runs against a real source gateway.
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyCacheHeuristic, matchPersona, strideSampleCidFile } from '../src/analyze.ts'

const GIB = 1024 ** 3

test('matchPersona picks laptop tester for a tiny job', () => {
  const p = matchPersona({
    totalAssets: 500,
    estimatedTotalBytes: 2 * GIB,
    carStoreFreeBytes: 40 * GIB,
    bandwidthMbit: 500,
  })
  assert.equal(p.name, 'Laptop tester')
  assert.equal(p.flags.maxInFlight, 1)
  assert.equal(p.flags.ingress, 'cloudflared')
})

test('matchPersona picks production migrator with disk and scale', () => {
  const p = matchPersona({
    totalAssets: 500_000,
    estimatedTotalBytes: 200 * GIB,
    carStoreFreeBytes: 300 * GIB,
    bandwidthMbit: 500,
  })
  assert.equal(p.name, 'Production migrator')
  assert.equal(p.flags.maxInFlight, 4)
  assert.equal(p.flags.ingress, 'funnel')
})

test('matchPersona picks bandwidth-bound when upload is slow', () => {
  const p = matchPersona({
    totalAssets: 1_000_000,
    estimatedTotalBytes: 50 * 1024 * GIB,
    carStoreFreeBytes: 60 * GIB,
    bandwidthMbit: 20,
  })
  assert.equal(p.name, 'Bandwidth-bound migrator')
  assert.equal(p.flags.maxInFlight, 1)
})

test('matchPersona falls back to SMB when nothing else fits', () => {
  const p = matchPersona({
    totalAssets: 50_000,
    estimatedTotalBytes: 30 * GIB,
    carStoreFreeBytes: 100 * GIB,
    bandwidthMbit: 200,
  })
  assert.equal(p.name, 'SMB / small studio')
})

test('applyCacheHeuristic forces cache when probe failure rate is high', () => {
  const base = matchPersona({
    totalAssets: 50_000,
    estimatedTotalBytes: 30 * GIB,
    carStoreFreeBytes: 200 * GIB,
    bandwidthMbit: 200,
  })
  const { persona, warnings } = applyCacheHeuristic(base, { carStoreFreeBytes: 200 * GIB, probeFailureRate: 0.1 })
  assert.equal(persona.flags.carStore, 'required')
  assert.ok(warnings.some((w) => w.includes('failure rate')))
})

test('applyCacheHeuristic downgrades to stream-only when disk is tight', () => {
  const base = matchPersona({
    totalAssets: 50_000,
    estimatedTotalBytes: 30 * GIB,
    carStoreFreeBytes: 20 * GIB,
    bandwidthMbit: 200,
  })
  const { persona, warnings } = applyCacheHeuristic(base, { carStoreFreeBytes: 20 * GIB, probeFailureRate: 0 })
  assert.equal(persona.flags.carStore, 'stream-only')
  assert.ok(warnings.some((w) => w.includes('below')))
})

test('strideSampleCidFile returns a stride sample without loading the full file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'analyze-'))
  const path = join(dir, 'cids.txt')
  const lines: string[] = []
  for (let i = 0; i < 1000; i++) lines.push(`bafy${i.toString().padStart(6, '0')}`)
  writeFileSync(path, lines.join('\n'))
  const { sample, total } = await strideSampleCidFile(path, 10, false)
  assert.equal(total, 1000)
  assert.equal(sample.length, 10)
  // first stride lands at index 0; last at index 900 (floor(9*1000/10))
  assert.equal(sample[0], 'bafy000000')
  assert.equal(sample[9], 'bafy000900')
})
