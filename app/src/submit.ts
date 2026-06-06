// Submit driver for the signing flow (#23): hand each selected provider the
// relay pull URLs for the prepared pieces, then confirm ONE on-chain commit
// per provider. The browser never moves payload bytes — the primary provider
// fetches the canonical CAR through the relay, secondaries copy
// provider-to-provider from the primary — and the wallet signs nothing here:
// every authorization is an EIP-712 presign by the session key, applied
// in-page without a prompt.
//
// Transaction shape per provider copy: a single create-and-add (or AddPieces
// when a matching data set already exists) covering EVERY piece in the run,
// submitted to the chain by the provider. One presign covers the pull and the
// commit for that provider.
//
// Reload safety (the at-most-once invariant):
// - presigns are persisted BEFORE the first pull. The provider's pull
//   endpoint is idempotent keyed on the extraData blob (verified:
//   @filoz/synapse-core src/sp/pull-pieces.ts pullPiecesApiRequest), so a
//   resumed run re-pulls with the SAME blob and gets status, not duplicates.
//   Presigning again would mint a new blob — pull() with no extraData signs
//   internally with a random clientDataSetId per call (verified:
//   @filoz/synapse-core src/sp/pull-pieces.ts signPullExtraData), which is
//   why the blob must be persisted and reused.
// - the commit txHash is persisted the moment the provider accepts the
//   submission; a resumed run polls the status endpoints reconstructed from
//   it and NEVER re-posts commit.
// - confirmation trusts context.commit/waitForAddPieces because the success
//   schema requires all three add-status signals — txStatus 'confirmed',
//   addMessageOk true, piecesAdded true (verified: @filoz/synapse-core
//   src/sp/add-pieces.ts AddPiecesSuccessSchema; per
//   skills/addstatus-three-signals.md a confirmed tx alone can carry a
//   reverted AddPieces call).
import type { PieceCID } from '@filoz/synapse-core/piece'
import type { PieceResult } from './commp.ts'
import { loadSubmit, type SavedSubmit, type SavedSubmitContext, saveSubmit } from './run-store.ts'
import { type SessionState, sessionCanPresign, walletChainClient } from './session.ts'
import { NETWORKS, type NetworkKey, type WalletState } from './wallet.ts'

export type SubmitPhase = 'queued' | 'presigning' | 'pulling' | 'committing' | 'confirming' | 'done' | 'failed'

export interface SubmitContextStatus extends SavedSubmitContext {
  phase: SubmitPhase
  /** Live per-piece pull status (pieceCid → pending|inProgress|retrying|complete|failed). */
  pullStatus?: Record<string, string>
}

export interface SubmitState {
  running: boolean
  /** False when IndexedDB writes fail — progress will not survive a reload. */
  persisted: boolean
  contexts: SubmitContextStatus[]
  error?: string
}

/**
 * The run cannot proceed without operator action: the session is inside its
 * presign safety margin (extend it) or a piece is under the provider's
 * minimum (drop it). Nothing was signed when this is thrown mid-run; the run
 * stays resumable.
 */
export class SubmitBlockedError extends Error {
  readonly reason: 'session-margin' | 'piece-too-small'
  constructor(message: string, reason: SubmitBlockedError['reason']) {
    super(message)
    this.name = 'SubmitBlockedError'
    this.reason = reason
  }
}

export interface SubmitOptions {
  wallet: WalletState
  network: NetworkKey
  session: SessionState
  /** Prepared pieces — every one is covered by each provider's single presign. */
  pieces: PieceResult[]
  /** Provider copies to store (primary + secondaries). Ignored when resuming. */
  copies: number
  /** Resume record from findResumableSubmit(); null starts a fresh run. */
  prior: SavedSubmit | null
  onUpdate: (state: SubmitState) => void
}

const pieceKey = (pieceCids: string[]): string => [...pieceCids].sort().join('\n')

const derivePhase = (c: SavedSubmitContext): SubmitPhase => {
  if (c.dataSetId != null && c.pieceIds != null) return 'done'
  if (c.txHash != null) return 'confirming'
  return 'queued'
}

/** Render a saved record as a non-running state — the reload restore view. */
export function submitStateFromSaved(saved: SavedSubmit): SubmitState {
  return { running: false, persisted: true, contexts: saved.contexts.map((c) => ({ ...c, phase: derivePhase(c) })) }
}

/**
 * The stored submit run, but only when it belongs to exactly this wallet,
 * network, and piece set — a presign is bound to all three, so anything else
 * must start fresh (or be discarded explicitly via clearSubmit).
 */
export async function findResumableSubmit(
  wallet: WalletState,
  network: NetworkKey,
  pieces: PieceResult[]
): Promise<SavedSubmit | null> {
  const saved = await loadSubmit()
  if (saved == null) return null
  if (saved.root.toLowerCase() !== wallet.address.toLowerCase()) return null
  if (saved.chainId !== NETWORKS[network].id) return null
  if (pieceKey(saved.pieceCids) !== pieceKey(pieces.map((p) => p.pieceCid))) return null
  return saved
}

async function deps() {
  const [sdk, sp, piece, guard, viem] = await Promise.all([
    import('@filoz/synapse-sdk'),
    import('@filoz/synapse-core/sp'),
    import('@filoz/synapse-core/piece'),
    import('ipfs2foc-core/min-piece-guard'),
    import('viem'),
  ])
  return { sdk, sp, piece, guard, viem }
}

export async function runSubmit(opts: SubmitOptions): Promise<SubmitState> {
  const { wallet, network, session, pieces, prior, onUpdate } = opts
  if (pieces.length === 0) throw new Error('no prepared pieces to submit')

  const { sdk, sp, piece, guard, viem } = await deps()
  const chains = { calibration: sdk.calibration, mainnet: sdk.mainnet }

  const parsed = pieces.map((p) => {
    const pieceCid = piece.asPieceCID(p.pieceCid)
    if (pieceCid == null) throw new Error(`not a PieceCID: ${p.pieceCid}`)
    return { pieceCid, sourceUrl: p.sourceUrl, ipfsCid: p.cid }
  })
  const sourceUrlByPiece = new Map(parsed.map((p) => [p.pieceCid.toString(), p.sourceUrl]))
  // Each piece carries its IPFS root as advisory metadata so the indexing the
  // data set requests (withIPFSIndexing) can map piece → DAG.
  const commitPieces = parsed.map((p) => ({
    pieceCid: p.pieceCid,
    pieceMetadata: { [sdk.METADATA_KEYS.IPFS_ROOT_CID]: p.ipfsCid },
  }))

  // Synapse.create() rejects session keys scoped below the full default
  // permission set (verified: @filoz/synapse-sdk src/synapse.ts Synapse.create
  // hasPermissions check), so construct directly — same shape as the SDK's
  // own session-key test: payer = the wallet client, signer = sessionClient.
  const client = walletChainClient(wallet, network, viem, chains)
  const synapse = new sdk.Synapse({ client, sessionClient: session.sessionClient, source: null })
  type Ctx = Awaited<ReturnType<(typeof synapse)['storage']['createContext']>>

  const record: SavedSubmit = prior ?? {
    root: wallet.address,
    chainId: NETWORKS[network].id,
    copies: opts.copies,
    pieceCids: parsed.map((p) => p.pieceCid.toString()).sort(),
    contexts: [],
    updatedAt: new Date().toISOString(),
  }

  const live: SubmitContextStatus[] = record.contexts.map((c) => ({ ...c, phase: derivePhase(c) }))
  const state: SubmitState = { running: true, persisted: true, contexts: live }
  const emit = () =>
    onUpdate({
      ...state,
      contexts: live.map((c) => ({ ...c, pullStatus: c.pullStatus ? { ...c.pullStatus } : undefined })),
    })
  const persist = async () => {
    record.contexts = live.map(({ phase, pullStatus, ...saved }) => saved)
    record.updatedAt = new Date().toISOString()
    try {
      await saveSubmit(record)
    } catch {
      // Storage-denied context (e.g. some private windows): keep going, but
      // the UI warns that a reload cannot resume this run.
      state.persisted = false
    }
    emit()
  }

  const liveCtx = new Map<string, Ctx>()
  // Data set tags follow filecoin-pin's defaults (its core/synapse/constants
  // DEFAULT_DATA_SET_METADATA): withIPFSIndexing asks the provider to index
  // every piece and announce to IPNI; source namespaces these data sets so
  // other apps sharing the wallet neither reuse nor match them. Piece-level
  // ipfsRootCID is set per piece above. There are no further IPNI keys —
  // ipniPiece/ipniIpfs are provider registry capabilities, not metadata.
  const metadata = {
    [sdk.METADATA_KEYS.WITH_IPFS_INDEXING]: '',
    [sdk.METADATA_KEYS.SOURCE]: 'ipfs2foc',
  }

  if (live.length === 0) {
    // Provider selection is the SDK's: createContexts picks an endorsed
    // primary and distinct secondaries; the operator chooses only the count.
    const ctxs = await synapse.storage.createContexts({ copies: record.copies, metadata })
    for (const [i, ctx] of ctxs.entries()) {
      liveCtx.set(ctx.provider.id.toString(), ctx)
      live.push({
        role: i === 0 ? 'primary' : 'secondary',
        providerId: ctx.provider.id.toString(),
        providerName: ctx.provider.name,
        serviceURL: ctx.provider.pdp.serviceURL,
        phase: 'queued',
      })
    }
  } else {
    // Re-bind a live context only where work remains; done and
    // pending-confirmation entries resume from the record alone.
    for (const c of live) {
      if (c.phase !== 'queued') continue
      const ctx = await synapse.storage.createContext({ providerId: BigInt(c.providerId), metadata })
      const resolved = ctx.dataSetId?.toString() ?? null
      if (c.extraData != null && (c.signedDataSetId ?? null) !== resolved) {
        // The blob was signed against a different data set state than the
        // provider resolves to now. Nothing was submitted under it (no
        // txHash), so discard and re-presign; the orphaned parked pull ages
        // out provider-side.
        c.extraData = undefined
        c.signedDataSetId = undefined
        c.pullComplete = undefined
      }
      liveCtx.set(c.providerId, ctx)
    }
  }
  // Also the resumability probe: a failed write flips `persisted` before any
  // signature exists, so the UI can warn while backing out is still free.
  await persist()

  // The provider floor is a PADDED piece-size minimum; check every piece
  // against every provider with outstanding work BEFORE the first signature
  // so a too-small piece can never strand a half-signed run.
  for (const c of live) {
    const ctx = liveCtx.get(c.providerId)
    if (ctx == null || c.phase !== 'queued') continue
    const check = guard.checkMinPieceSize(
      parsed.map((p) => ({ pieceCid: p.pieceCid.toString() })),
      ctx.provider.pdp.minPieceSizeInBytes
    )
    if (!check.ok) {
      state.running = false
      emit()
      const names = check.tooSmall.map((t) => t.pieceCid).join(', ')
      throw new SubmitBlockedError(
        `${check.tooSmall.length} piece(s) below provider ${c.providerId} minimum of ${check.minPieceSize} bytes (padded): ${names}`,
        'piece-too-small'
      )
    }
  }

  const ensurePresigned = async (c: SubmitContextStatus, ctx: Ctx) => {
    if (c.extraData != null) return
    if (!sessionCanPresign(session)) {
      throw new SubmitBlockedError(
        'session expires within the safety margin — extend it before submitting',
        'session-margin'
      )
    }
    c.phase = 'presigning'
    emit()
    c.signedDataSetId = ctx.dataSetId?.toString()
    c.extraData = await ctx.presignForCommit(commitPieces)
    // Persisted before the pull goes out: the blob is the idempotency key a
    // resumed run needs to re-issue this pull without duplicating it.
    await persist()
  }

  const pullTo = async (c: SubmitContextStatus, ctx: Ctx, from: string | ((pieceCid: PieceCID) => string)) => {
    if (c.pullComplete === true) return
    c.phase = 'pulling'
    c.pullStatus = Object.fromEntries(parsed.map((p) => [p.pieceCid.toString(), 'pending']))
    emit()
    const result = await ctx.pull({
      pieces: parsed.map((p) => p.pieceCid),
      from,
      extraData: c.extraData,
      onProgress: (pieceCid, status) => {
        if (c.pullStatus != null) c.pullStatus[pieceCid.toString()] = status
        emit()
      },
    })
    if (result.status !== 'complete') {
      const failed = result.pieces.filter((p) => p.status !== 'complete').map((p) => p.pieceCid.toString())
      throw new Error(`provider could not pull ${failed.length} piece(s): ${failed.join(', ')}`)
    }
    c.pullComplete = true
    await persist()
  }

  const confirmCommit = async (c: SubmitContextStatus, ctx: Ctx | undefined) => {
    if (c.phase === 'done') return
    if (c.txHash == null) {
      if (ctx == null) throw new Error('storage context unavailable')
      c.phase = 'committing'
      emit()
      const result = await ctx.commit({
        pieces: commitPieces,
        extraData: c.extraData,
        onSubmitted: (txHash) => {
          // The provider accepted the submission — record the hash NOW so a
          // reload polls its status instead of ever re-posting commit.
          c.txHash = txHash
          c.phase = 'confirming'
          void persist()
        },
      })
      c.dataSetId = result.dataSetId.toString()
      c.pieceIds = result.pieceIds.map((id) => id.toString())
    } else if (c.signedDataSetId == null) {
      // Resume a create-and-add commit. Status URL shape verified against
      // @filoz/synapse-core src/sp/create-dataset-add-pieces.ts; the helper
      // chains the data set leg into the AddPieces leg itself.
      c.phase = 'confirming'
      emit()
      const confirmation = await sp.waitForCreateDataSetAddPieces({
        statusUrl: new URL(`/pdp/data-sets/created/${c.txHash}`, c.serviceURL).toString(),
      })
      c.dataSetId = confirmation.dataSetId.toString()
      c.pieceIds = confirmation.piecesIds.map((id) => id.toString())
    } else {
      // Resume an AddPieces commit. Status URL shape verified against
      // @filoz/synapse-core src/sp/add-pieces.ts addPiecesApiRequest (the
      // Location header it returns).
      c.phase = 'confirming'
      emit()
      const confirmation = await sp.waitForAddPieces({
        statusUrl: new URL(`/pdp/data-sets/${c.signedDataSetId}/pieces/added/${c.txHash}`, c.serviceURL).toString(),
      })
      c.dataSetId = c.signedDataSetId
      c.pieceIds = confirmation.confirmedPieceIds.map((id) => id.toString())
    }
    c.phase = 'done'
    await persist()
  }

  try {
    const primary = live[0]
    const secondaries = live.slice(1)

    // The primary's bytes must be parked before anything else: secondaries
    // copy from it, and its own commit needs them present. A primary already
    // confirming or done has parked bytes by construction.
    if (primary.phase === 'queued') {
      const ctx = liveCtx.get(primary.providerId)
      if (ctx == null) throw new Error('primary storage context unavailable')
      await ensurePresigned(primary, ctx)
      await pullTo(primary, ctx, (pieceCid) => {
        const url = sourceUrlByPiece.get(pieceCid.toString())
        if (url == null) throw new Error(`no source URL for ${pieceCid.toString()}`)
        return url
      })
    }

    // Primary commit and each secondary's pull→commit only need the parked
    // primary bytes — run them concurrently, one failure never blocking the
    // rest (each copy is an independent on-chain data set).
    const jobs = [
      (async () => {
        if (primary.phase !== 'done') await confirmCommit(primary, liveCtx.get(primary.providerId))
      })(),
      ...secondaries.map((c) =>
        (async () => {
          if (c.phase === 'done') return
          if (c.txHash != null) {
            await confirmCommit(c, undefined)
            return
          }
          const ctx = liveCtx.get(c.providerId)
          if (ctx == null) throw new Error('storage context unavailable')
          await ensurePresigned(c, ctx)
          await pullTo(c, ctx, primary.serviceURL)
          await confirmCommit(c, ctx)
        })()
      ),
    ]
    const settled = await Promise.allSettled(jobs)
    let blocked: SubmitBlockedError | null = null
    settled.forEach((s, i) => {
      if (s.status !== 'rejected') return
      const c = i === 0 ? primary : secondaries[i - 1]
      if (s.reason instanceof SubmitBlockedError) {
        // Not a provider failure — the context stays queued and resumable.
        blocked = s.reason
        if (c.phase !== 'done') c.phase = 'queued'
        return
      }
      if (c.phase !== 'done') {
        c.phase = 'failed'
        c.error = s.reason instanceof Error ? s.reason.message : String(s.reason)
      }
    })
    await persist()
    if (blocked != null) throw blocked
    return state
  } finally {
    state.running = false
    emit()
  }
}
