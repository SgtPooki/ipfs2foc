import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MigrationDB } from '../src/db.ts'
import { type BinBuilder, runPackCars } from '../src/pack-cars.ts'

// H3: a bin that fails to assemble must surface its source CIDs
// (summary.failedMemberCids), not just bump a bin-level counter.

// planBins sorts/dedupes by CID bytes, so source CIDs must be valid CIDs.
const SRC1 = 'bafybeia2yt37rxkqu7ovw6ja3nf2aqatrzpcwh2tvl2kqbgeqcccn5evhy'
const SRC2 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
// Real PieceCIDs (fixture) so commP / aggregate-append can parse them.
const PC1 = 'bafkzcibf3ck4uais4fgennh4hbfx5z3i6hue4xgq2cdeamtus4hjbsrjs5lf2azbxmsa'
const PC2 = 'bafkzcibewpkqwewyhz3yxutlxbpt2nkb6si5qilg4qqtzzij32uw7ammsc73a4wkgi'
const REAL_PIECE_CID = 'bafkzcibftk7jmaytlewyhwwszv2ej4wws45pkn2dsquy4mfaytqap4xnaegks3nfxyhq'

async function dbAt(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `foc-${name}-`))
  return { dir, db: new MigrationDB(join(dir, 'migrate.db')) }
}

function seedTwoFreePieces(db: MigrationDB) {
  db.addCids([SRC1, SRC2])
  db.recordPieceSuccess(SRC1, PC1, 100, 'g', `https://gw/ipfs/${SRC1}?format=car`, 'sha1')
  db.recordPieceSuccess(SRC2, PC2, 200, 'g', `https://gw/ipfs/${SRC2}?format=car`, 'sha2')
}

test('a failed bin records its member CIDs in failedMemberCids', async () => {
  const { dir, db } = await dbAt('pack-fail')
  try {
    seedTwoFreePieces(db)
    const throwingBuilder: BinBuilder = async () => {
      throw new Error('member CAR had a zero-length section')
    }
    const summary = await runPackCars(
      db,
      { gateways: [], carStore: dir, targetSizeBytes: 512 * 1024 * 1024 },
      throwingBuilder
    )
    assert.equal(summary.built, 0)
    assert.equal(summary.failed, 1) // one bin
    assert.deepEqual([...summary.failedMemberCids].sort(), [SRC1, SRC2].sort())
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a successful bin builds and leaves failedMemberCids empty', async () => {
  const { dir, db } = await dbAt('pack-ok')
  try {
    seedTwoFreePieces(db)
    const okBuilder: BinBuilder = async () => ({
      pieceCid: REAL_PIECE_CID,
      assembledBytes: 300,
      sha256: 'sha-assembled',
      filePath: join(dir, 'assembled.car'),
    })
    const summary = await runPackCars(
      db,
      { gateways: [], carStore: dir, targetSizeBytes: 512 * 1024 * 1024 },
      okBuilder
    )
    assert.equal(summary.built, 1)
    assert.equal(summary.failed, 0)
    assert.deepEqual(summary.failedMemberCids, [])
    // the built sub-piece is recorded over both source CIDs
    assert.deepEqual(db.subPieceMemberCids(REAL_PIECE_CID).sort(), [SRC1, SRC2].sort())
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
