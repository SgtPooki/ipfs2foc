import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildCarUrl, relayPullUrl } from 'ipfs2foc-core'
import { buildManifest } from 'ipfs2foc-core/manifest'
import { MigrationDB } from '../src/db.ts'
import { buildExportManifest } from '../src/export-manifest.ts'
import { parseRunManifest, runImportManifest } from '../src/import-manifest.ts'

// Pinned real values (same as commp-piece-cid-regression.test.ts) so the
// canonical-CID and PieceCID-v2 validators run against genuine strings. No
// network: export/import never fetch.
const CID_A = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const PIECE_A = 'bafkzcibdxzhqyefkufvnsmqlyrjyr3el6affnfo3l7ipfncjjzjl4hkaqhbaema3'
const SIZE_A = 119874
const CID_B = 'bafybeia2yt37rxkqu7ovw6ja3nf2aqatrzpcwh2tvl2kqbgeqcccn5evhy'
const PIECE_B = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'
const SIZE_B = 5010728
const GATEWAY = 'https://trustless-gateway.link'
const RELAY = 'https://relay.example.com'
const AGG = 34359738368n // 32 GiB

async function withDb(fn: (db: MigrationDB) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ipfs2foc-export-'))
  const db = new MigrationDB(join(dir, 'm.db'))
  try {
    await fn(db)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
}

/** Seed a DB with two done pieces on one gateway. */
function seedTwoDonePieces(db: MigrationDB): void {
  db.addCids([CID_A, CID_B])
  db.recordPieceSuccess(CID_A, PIECE_A, SIZE_A, GATEWAY, buildCarUrl(GATEWAY, CID_A))
  db.recordPieceSuccess(CID_B, PIECE_B, SIZE_B, GATEWAY, buildCarUrl(GATEWAY, CID_B))
}

test('export emits a v1 manifest of the DB done pieces (gateway-direct sourceUrl)', async () => {
  await withDb((db) => {
    seedTwoDonePieces(db)
    const { manifest, excludedOversized } = buildExportManifest(db, { network: 'calibration', now: 'T' })
    assert.equal(excludedOversized, 0)
    assert.equal(manifest.version, 1)
    assert.equal(manifest.tool, 'ipfs2foc')
    assert.equal(manifest.network, 'calibration')
    assert.equal(manifest.gateway, GATEWAY)
    assert.equal(manifest.relayBase, null)
    assert.equal(manifest.pieces.length, 2)
    const a = manifest.pieces.find((p) => p.cid === CID_A)
    assert.ok(a != null)
    assert.equal(a.pieceCid, PIECE_A)
    assert.equal(a.rawSize, SIZE_A)
    // No --source-relay -> sourceUrl is the direct gateway CAR URL.
    assert.equal(a.sourceUrl, buildCarUrl(GATEWAY, CID_A))
  })
})

test('export with --source-relay routes sourceUrl through the relay', async () => {
  await withDb((db) => {
    seedTwoDonePieces(db)
    const { manifest } = buildExportManifest(db, { network: 'mainnet', relayBase: RELAY, now: 'T' })
    assert.equal(manifest.relayBase, RELAY)
    const a = manifest.pieces.find((p) => p.cid === CID_A)
    assert.ok(a != null)
    assert.equal(a.sourceUrl, relayPullUrl(RELAY, 'trustless-gateway.link', CID_A, PIECE_A))
  })
})

test('exported manifest is valid input to parseRunManifest (export is import-shaped)', async () => {
  await withDb((db) => {
    seedTwoDonePieces(db)
    const { manifest } = buildExportManifest(db, { network: 'calibration', now: 'T' })
    // Would throw if any field were invalid (CID, PieceCID, sizes, sourceUrl).
    const parsed = parseRunManifest(JSON.stringify(manifest))
    assert.equal(parsed.pieces.length, 2)
    assert.equal(parsed.gateway, GATEWAY)
  })
})

test('round-trip: export from one DB imports cleanly into a fresh DB', async () => {
  await withDb(async (src) => {
    seedTwoDonePieces(src)
    const { manifest } = buildExportManifest(src, { network: 'calibration', now: 'T' })
    const json = JSON.stringify(manifest)

    await withDb((dst) => {
      const parsed = parseRunManifest(json)
      const summary = runImportManifest(dst, parsed, { network: 'calibration', aggregateSizeBytes: AGG })
      assert.equal(summary.imported, 2)
      assert.equal(summary.alreadyRecorded, 0)
      // The commitments survive the round-trip byte-for-byte.
      assert.equal(dst.pieceByCid(CID_A)?.pieceCid, PIECE_A)
      assert.equal(dst.pieceByCid(CID_B)?.pieceCid, PIECE_B)
      assert.equal(dst.pieceByCid(CID_A)?.rawSize, SIZE_A)
    })
  })
})

test('export and the browser buildManifest produce the same field shape', async () => {
  await withDb((db) => {
    seedTwoDonePieces(db)
    const { manifest } = buildExportManifest(db, { network: 'calibration', now: 'T' })
    // The browser console builds the same v1 shape from its PieceResult list.
    const appShape = buildManifest([{ cid: CID_A, pieceCid: PIECE_A, rawSize: SIZE_A, sourceUrl: 'x' }], {
      tool: 'ipfs2foc-app',
      network: 'calibration',
      relayBase: RELAY,
      gateway: GATEWAY,
      now: 'T',
    })
    assert.deepEqual(Object.keys(manifest).sort(), Object.keys(appShape).sort())
    assert.deepEqual(Object.keys(manifest.pieces[0]).sort(), Object.keys(appShape.pieces[0]).sort())
  })
})

test('export refuses an empty DB', async () => {
  await withDb((db) => {
    assert.throws(() => buildExportManifest(db, { network: 'calibration', now: 'T' }), /no done pieces/)
  })
})

test('export refuses done pieces spanning multiple gateways (v1 is single-gateway)', async () => {
  await withDb((db) => {
    const other = 'https://other-gateway.example'
    db.addCids([CID_A, CID_B])
    db.recordPieceSuccess(CID_A, PIECE_A, SIZE_A, GATEWAY, buildCarUrl(GATEWAY, CID_A))
    db.recordPieceSuccess(CID_B, PIECE_B, SIZE_B, other, buildCarUrl(other, CID_B))
    assert.throws(() => buildExportManifest(db, { network: 'calibration', now: 'T' }), /single-gateway/)
  })
})
