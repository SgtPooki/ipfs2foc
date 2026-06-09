import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildCarUrl } from 'ipfs2foc-core'
import { MigrationDB } from '../src/db.ts'
import { parseRunManifest, runImportManifest } from '../src/import-manifest.ts'
import { runPlan } from '../src/migrate.ts'

// Pinned real values (same as test/commp-piece-cid-regression.test.ts) so the
// canonical-CID and PieceCID-v2 validators run against genuine strings. No
// network involved: import never fetches.
const CID_A = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const PIECE_A = 'bafkzcibdxzhqyefkufvnsmqlyrjyr3el6affnfo3l7ipfncjjzjl4hkaqhbaema3'
const SIZE_A = 119874
const CID_B = 'bafybeia2yt37rxkqu7ovw6ja3nf2aqatrzpcwh2tvl2kqbgeqcccn5evhy'
const PIECE_B = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'
const SIZE_B = 5010728

const GATEWAY = 'https://trustless-gateway.link'
const RELAY = 'https://relay.example.com'

function manifestJson(overrides: Record<string, unknown> = {}, pieceOverrides: Record<string, unknown>[] = []): string {
  const pieces = [
    {
      cid: CID_A,
      pieceCid: PIECE_A,
      rawSize: SIZE_A,
      sourceUrl: `${RELAY}/r/trustless-gateway.link/${CID_A}/piece/${PIECE_A}`,
      ...(pieceOverrides[0] ?? {}),
    },
  ]
  return JSON.stringify({
    version: 1,
    tool: 'ipfs2foc-app',
    createdAt: '2026-06-07T00:00:00.000Z',
    network: 'calibration',
    relayBase: RELAY,
    gateway: GATEWAY,
    pieces,
    ...overrides,
  })
}

async function dbAt(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `foc-${name}-`))
  return { dir, db: new MigrationDB(join(dir, 'migrate.db')) }
}

const AGG_SIZE = 32n * 1024n * 1024n * 1024n

test('parseRunManifest accepts a valid version-1 manifest', () => {
  const m = parseRunManifest(manifestJson())
  assert.equal(m.network, 'calibration')
  assert.equal(m.gateway, GATEWAY)
  assert.equal(m.relayBase, RELAY)
  assert.equal(m.pieces.length, 1)
  assert.deepEqual(m.pieces[0], {
    cid: CID_A,
    pieceCid: PIECE_A,
    rawSize: SIZE_A,
    sourceUrl: `${RELAY}/r/trustless-gateway.link/${CID_A}/piece/${PIECE_A}`,
  })
})

test('parseRunManifest refuses malformed input with the offending field named', () => {
  assert.throws(() => parseRunManifest('{nope'), /not valid JSON/)
  assert.throws(() => parseRunManifest('[]'), /JSON object/)
  assert.throws(() => parseRunManifest(manifestJson({ gateway: undefined })), /"gateway"/)
  assert.throws(() => parseRunManifest(manifestJson({ gateway: 'not a url' })), /not a URL/)
  assert.throws(() => parseRunManifest(manifestJson({ gateway: 'ftp://x.example' })), /http\(s\)/)
  assert.throws(() => parseRunManifest(manifestJson({ network: undefined })), /"network"/)
  assert.throws(() => parseRunManifest(manifestJson({ pieces: [] })), /no pieces/)
  // CIDv0: parseable, but not the canonical CIDv1 the commitment was bound to.
  assert.throws(
    () => parseRunManifest(manifestJson({}, [{ cid: 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR' }])),
    /canonical CIDv1/
  )
  // A plain CID is not a PieceCID v2.
  assert.throws(() => parseRunManifest(manifestJson({}, [{ pieceCid: CID_B }])), /not a PieceCID v2/)
  assert.throws(() => parseRunManifest(manifestJson({}, [{ rawSize: -5 }])), /positive integer/)
  assert.throws(() => parseRunManifest(manifestJson({}, [{ rawSize: 1.5 }])), /positive integer/)
  assert.throws(() => parseRunManifest(manifestJson({}, [{ sourceUrl: '' }])), /"sourceUrl"/)
})

test('parseRunManifest refuses duplicate cids and shared PieceCIDs', () => {
  const dupCid = JSON.parse(manifestJson())
  dupCid.pieces.push({ ...dupCid.pieces[0] })
  assert.throws(() => parseRunManifest(JSON.stringify(dupCid)), /duplicate cid/)

  const dupPiece = JSON.parse(manifestJson())
  dupPiece.pieces.push({ ...dupPiece.pieces[0], cid: CID_B })
  assert.throws(() => parseRunManifest(JSON.stringify(dupPiece)), /already used by pieces\[0\]/)
})

test('version gate: newer versions and non-manifests are refused explicitly', () => {
  assert.throws(() => parseRunManifest(manifestJson({ version: 2 })), /newer than this tool understands/)
  assert.throws(() => parseRunManifest(manifestJson({ version: undefined })), /expected "version": 1/)
  assert.throws(() => parseRunManifest(manifestJson({ version: '1' })), /expected "version": 1/)
})

test('network mismatch is refused and writes nothing', async () => {
  const { dir, db } = await dbAt('import-network')
  try {
    const manifest = parseRunManifest(manifestJson())
    assert.throws(
      () => runImportManifest(db, manifest, { network: 'mainnet', aggregateSizeBytes: AGG_SIZE }),
      /prepared on calibration but this import targets --network mainnet/
    )
    assert.equal(db.counts().total, 0)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('import records done pieces, passthrough sub-pieces, and a planned aggregate', async () => {
  const { dir, db } = await dbAt('import-basic')
  try {
    const manifest = parseRunManifest(manifestJson())
    const summary = runImportManifest(db, manifest, { network: 'calibration', aggregateSizeBytes: AGG_SIZE })
    assert.deepEqual(summary, {
      network: 'calibration',
      total: 1,
      imported: 1,
      alreadyRecorded: 0,
      aggregateCount: 1,
      oversized: [],
    })
    const piece = db.pieceByCid(CID_A)
    assert.equal(piece?.status, 'done')
    assert.equal(piece?.pieceCid, PIECE_A)
    assert.equal(piece?.rawSize, SIZE_A)
    assert.equal(piece?.gateway, GATEWAY)
    // The stored url is the canonical gateway CAR URL — the bytes the
    // commitment was computed over — not the manifest's relay sourceUrl.
    assert.equal(piece?.url, buildCarUrl(GATEWAY, CID_A))
    assert.deepEqual(db.aggregateManifest(0), [
      { pieceCid: PIECE_A, url: buildCarUrl(GATEWAY, CID_A), rawSize: SIZE_A },
    ])
    assert.equal(db.aggregates()[0]?.status, 'planned')
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('re-import is idempotent: no duplicate rows, no new aggregates', async () => {
  const { dir, db } = await dbAt('import-idempotent')
  try {
    const manifest = parseRunManifest(manifestJson())
    runImportManifest(db, manifest, { network: 'calibration', aggregateSizeBytes: AGG_SIZE })
    const summary = runImportManifest(db, manifest, { network: 'calibration', aggregateSizeBytes: AGG_SIZE })
    assert.equal(summary.imported, 0)
    assert.equal(summary.alreadyRecorded, 1)
    assert.equal(summary.aggregateCount, 1)
    assert.equal(db.counts().total, 1)
    assert.equal(db.counts().done, 1)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a done piece is never clobbered: conflicting commitment refuses the whole import', async () => {
  const { dir, db } = await dbAt('import-conflict')
  try {
    db.addCids([CID_A])
    db.recordPieceSuccess(CID_A, PIECE_B, SIZE_B, GATEWAY, buildCarUrl(GATEWAY, CID_A), null)

    const two = JSON.parse(manifestJson())
    two.pieces.push({
      cid: CID_B,
      pieceCid: PIECE_B,
      rawSize: SIZE_B,
      sourceUrl: `${RELAY}/r/trustless-gateway.link/${CID_B}/piece/${PIECE_B}`,
    })
    const manifest = parseRunManifest(JSON.stringify(two))
    assert.throws(
      () => runImportManifest(db, manifest, { network: 'calibration', aggregateSizeBytes: AGG_SIZE }),
      /refusing to import: 1 piece\(s\) conflict/
    )
    // The pre-pass refused before writing: the non-conflicting CID_B entry
    // must not have landed either.
    assert.equal(db.pieceByCid(CID_B), null)
    // And the existing row is untouched.
    assert.equal(db.pieceByCid(CID_A)?.pieceCid, PIECE_B)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an imported piece is row-equivalent to a plan-produced one', async () => {
  const planned = await dbAt('import-equiv-plan')
  const imported = await dbAt('import-equiv-import')
  try {
    // Plan path, with the fetcher faked to return exactly what the browser
    // manifest carries (plus no sha256, which the manifest never has).
    planned.db.addCids([CID_A])
    await runPlan(planned.db, { gateways: [GATEWAY], aggregateSizeBytes: AGG_SIZE, concurrency: 1 }, async (cid) => ({
      cid,
      pieceCid: PIECE_A,
      rawSize: SIZE_A,
      gateway: GATEWAY,
      url: buildCarUrl(GATEWAY, cid),
      source: 'gateway' as const,
    }))

    const manifest = parseRunManifest(manifestJson())
    runImportManifest(imported.db, manifest, { network: 'calibration', aggregateSizeBytes: AGG_SIZE })

    assert.deepEqual(imported.db.donePieces(), planned.db.donePieces())
    assert.deepEqual(imported.db.aggregateManifest(0), planned.db.aggregateManifest(0))
    const stripTimes = (a: ReturnType<MigrationDB['aggregates']>) =>
      a.map(({ submittedAt: _s, parkedAt: _p, committedAt: _c, ...rest }) => rest)
    assert.deepEqual(stripTimes(imported.db.aggregates()), stripTimes(planned.db.aggregates()))
  } finally {
    planned.db.close()
    imported.db.close()
    await rm(planned.dir, { recursive: true, force: true })
    await rm(imported.dir, { recursive: true, force: true })
  }
})

test('import upgrades a previously failed piece to done', async () => {
  const { dir, db } = await dbAt('import-upgrade')
  try {
    db.addCids([CID_A])
    db.recordPieceFailure(CID_A, 'gateway 504', 'source_gateway_5xx')
    const manifest = parseRunManifest(manifestJson())
    const summary = runImportManifest(db, manifest, { network: 'calibration', aggregateSizeBytes: AGG_SIZE })
    assert.equal(summary.imported, 1)
    const piece = db.pieceByCid(CID_A)
    assert.equal(piece?.status, 'done')
    assert.equal(piece?.error, null)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
