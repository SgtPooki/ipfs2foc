// Submit driver for the signing flow (#23): hand each selected provider the
// relay pull URLs for the prepared pieces, then confirm ONE on-chain commit
// per provider. The browser never moves payload bytes — the primary provider
// fetches the canonical CAR through the relay, secondaries copy
// provider-to-provider from the primary — and the wallet signs nothing here:
// every authorization is an EIP-712 presign by the session key, applied
// in-page without a prompt.
//
// Transaction shape per provider copy: the run is split into chunks (providers
// cap the pieces per pull request), and each chunk gets its own presign, pull,
// and on-chain add — the first chunk creates the data set (create-and-add,
// or plain AddPieces when a matching data set already exists), later chunks
// add to the resolved data set. Every transaction is submitted to the chain
// by the provider; one presign covers one chunk's pull and commit.
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
import { loadSubmit, type SavedChunk, type SavedSubmit, type SavedSubmitContext, saveSubmit } from './run-store.ts'
import { type SessionState, sessionCanPresign, walletChainClient } from './session.ts'
import { NETWORKS, type NetworkKey, type WalletState } from './wallet.ts'

/**
 * Max pieces per pull request / per on-chain add. Provider pull admission
 * caps the count (observed: a provider refusing 73 with "maximum allowed per
 * pull (40)"); the cap is not advertised in the SP registry, so this mirrors
 * the CLI's `--pull-batch` default, which also respects the 8192-byte FVM
 * event cap on the simulated AddPieces.
 */
export const PULL_CHUNK_SIZE = 32

export type SubmitPhase = 'queued' | 'presigning' | 'pulling' | 'committing' | 'confirming' | 'done' | 'failed'

export interface SubmitContextStatus extends SavedSubmitContext {
  phase: SubmitPhase
  /** Live per-piece pull status (pieceCid → pending|inProgress|retrying|complete|failed). */
  pullStatus?: Record<string, string>
  /** Live chunk cursor for the status line; only meaningful while running. */
  chunkIndex?: number
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
  /** For 'piece-too-small': the offending PieceCIDs, so the UI can offer to submit the rest. */
  readonly pieceCids?: string[]
  constructor(message: string, reason: SubmitBlockedError['reason'], pieceCids?: string[]) {
    super(message)
    this.name = 'SubmitBlockedError'
    this.reason = reason
    this.pieceCids = pieceCids
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
  /**
   * Skip the advertised min-piece-size pre-check. The registry value appears
   * to be advisory (no enforcement found in the provider's pull path); with
   * this set the provider itself is the judge and a real rejection surfaces
   * in the per-piece pull status.
   */
  ignoreMinPieceSize?: boolean
  /** Resume record from findResumableSubmit(); null starts a fresh run. */
  prior: SavedSubmit | null
  onUpdate: (state: SubmitState) => void
}

const pieceKey = (pieceCids: string[]): string => [...pieceCids].sort().join('\n')

const derivePhase = (c: SavedSubmitContext): SubmitPhase => {
  if (c.chunks.length > 0 && c.chunks.every((ch) => ch.committed === true)) return 'done'
  if (c.chunks.some((ch) => ch.txHash != null && ch.committed !== true)) return 'confirming'
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
  const [sdk, sp, piece, guard, viem, abis] = await Promise.all([
    import('@filoz/synapse-sdk'),
    import('@filoz/synapse-core/sp'),
    import('@filoz/synapse-core/piece'),
    import('ipfs2foc-core/min-piece-guard'),
    import('viem'),
    import('@filoz/synapse-core/abis'),
  ])
  return { sdk, sp, piece, guard, viem, abis }
}

export async function runSubmit(opts: SubmitOptions): Promise<SubmitState> {
  const { wallet, network, session, pieces, prior, onUpdate } = opts
  if (pieces.length === 0) throw new Error('no prepared pieces to submit')

  const { sdk, sp, piece, guard, viem, abis } = await deps()
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
    version: 2,
    root: wallet.address,
    chainId: NETWORKS[network].id,
    copies: opts.copies,
    pieceCids: parsed.map((p) => p.pieceCid.toString()).sort(),
    contexts: [],
    updatedAt: new Date().toISOString(),
  }

  const parsedByCid = new Map(parsed.map((p) => [p.pieceCid.toString(), p]))
  const commitPiecesByCid = new Map(commitPieces.map((p) => [p.pieceCid.toString(), p]))
  const commitPiecesFor = (chunk: SavedChunk) =>
    chunk.pieceCids.map((cid) => {
      const p = commitPiecesByCid.get(cid)
      if (p == null) throw new Error(`saved chunk references unknown piece ${cid}`)
      return p
    })
  // Chunk piece sets are fixed when the run is planned and reused verbatim on
  // resume — re-splitting under a changed PULL_CHUNK_SIZE would orphan the
  // presigns already persisted against the original sets.
  const planChunks = (): SavedChunk[] => {
    const cids = parsed.map((p) => p.pieceCid.toString())
    const chunks: SavedChunk[] = []
    for (let i = 0; i < cids.length; i += PULL_CHUNK_SIZE) {
      chunks.push({ pieceCids: cids.slice(i, i + PULL_CHUNK_SIZE) })
    }
    return chunks
  }

  const live: SubmitContextStatus[] = record.contexts.map((c) => ({ ...c, phase: derivePhase(c) }))
  const state: SubmitState = { running: true, persisted: true, contexts: live }
  const emit = () =>
    onUpdate({
      ...state,
      contexts: live.map((c) => ({ ...c, pullStatus: c.pullStatus ? { ...c.pullStatus } : undefined })),
    })
  const persist = async () => {
    record.contexts = live.map(({ phase, pullStatus, chunkIndex, ...saved }) => saved)
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
      // A context may resolve straight to an existing matching data set; pin
      // it so every chunk takes the plain AddPieces path from the start.
      const resolved = ctx.dataSetId?.toString()
      liveCtx.set(`${ctx.provider.id.toString()}:${resolved ?? 'new'}`, ctx)
      live.push({
        role: i === 0 ? 'primary' : 'secondary',
        providerId: ctx.provider.id.toString(),
        providerName: ctx.provider.name,
        serviceURL: ctx.provider.pdp.serviceURL,
        dataSetId: resolved,
        chunks: planChunks(),
        phase: 'queued',
      })
    }
  }
  // Resumed contexts re-bind lazily in bindCtx, keyed on the data set they
  // resolved to; per-chunk presign staleness is checked at presign time.

  /**
   * Bind (or re-bind) the live storage context for a copy. Before the first
   * committed chunk the provider resolves the data set itself (an existing
   * metadata match, or create-and-add); once `dataSetId` is known every later
   * chunk targets it explicitly so the AddPieces path is deterministic.
   */
  const bindCtx = async (c: SubmitContextStatus): Promise<Ctx> => {
    const key = `${c.providerId}:${c.dataSetId ?? 'new'}`
    const cached = liveCtx.get(key)
    if (cached != null) return cached
    let ctx: Ctx
    if (c.dataSetId == null) {
      ctx = await synapse.storage.createContext({ providerId: BigInt(c.providerId), metadata })
      if (ctx.dataSetId != null) {
        // The provider already resolves to a matching data set — pin it so
        // every chunk (including the first) takes the plain AddPieces path.
        c.dataSetId = ctx.dataSetId.toString()
        liveCtx.set(`${c.providerId}:${c.dataSetId}`, ctx)
        await persist()
        return ctx
      }
    } else {
      const [bound] = await synapse.storage.createContexts({ dataSetIds: [BigInt(c.dataSetId)], metadata })
      if (bound == null) throw new Error(`no storage context for data set ${c.dataSetId}`)
      ctx = bound
    }
    liveCtx.set(key, ctx)
    return ctx
  }
  // Also the resumability probe: a failed write flips `persisted` before any
  // signature exists, so the UI can warn while backing out is still free.
  await persist()

  // The provider floor is a PADDED piece-size minimum; check every piece
  // against every provider with outstanding work BEFORE the first signature
  // so a too-small piece can never strand a half-signed run.
  for (const c of live) {
    if (opts.ignoreMinPieceSize === true) break
    if (c.phase !== 'queued') continue
    const ctx = await bindCtx(c)
    const check = guard.checkMinPieceSize(
      parsed.map((p) => ({ pieceCid: p.pieceCid.toString() })),
      ctx.provider.pdp.minPieceSizeInBytes
    )
    if (!check.ok) {
      state.running = false
      emit()
      // Operator-facing: name the problem in sizes, not a wall of piece CIDs —
      // the UI pairs this with the packing walkthrough (the actual next step).
      const sample = check.tooSmall
        .slice(0, 3)
        .map((t) => t.pieceCid)
        .join(', ')
      const more = check.tooSmall.length > 3 ? ` … and ${check.tooSmall.length - 3} more` : ''
      const minMiB = Number(check.minPieceSize) / 1048576
      throw new SubmitBlockedError(
        `${check.tooSmall.length} of ${parsed.length} items are smaller than this provider's ${minMiB % 1 === 0 ? minMiB : minMiB.toFixed(1)} MiB minimum piece size: ${sample}${more}`,
        'piece-too-small',
        check.tooSmall.map((t) => t.pieceCid)
      )
    }
  }

  const ensurePresigned = async (c: SubmitContextStatus, chunk: SavedChunk, ctx: Ctx) => {
    const resolved = ctx.dataSetId?.toString() ?? null
    if (chunk.extraData != null) {
      if ((chunk.signedDataSetId ?? null) === resolved) return
      // The blob was signed against a different data set state than the
      // provider resolves to now. Nothing was submitted under it (no
      // txHash), so discard and re-presign; the orphaned parked pull ages
      // out provider-side.
      chunk.extraData = undefined
      chunk.signedDataSetId = undefined
      chunk.pullComplete = undefined
    }
    if (!sessionCanPresign(session)) {
      throw new SubmitBlockedError(
        'session expires within the safety margin — extend it before submitting',
        'session-margin'
      )
    }
    c.phase = 'presigning'
    emit()
    chunk.signedDataSetId = resolved ?? undefined
    chunk.extraData = await ctx.presignForCommit(commitPiecesFor(chunk))
    // Persisted before the pull goes out: the blob is the idempotency key a
    // resumed run needs to re-issue this pull without duplicating it.
    await persist()
  }

  // The whole-run pull map the UI counts: pieces from already-committed or
  // already-pulled chunks start as complete so a resumed run reads honestly.
  const seedPullStatus = (c: SubmitContextStatus) => {
    if (c.pullStatus != null) return
    c.pullStatus = {}
    for (const chunk of c.chunks) {
      const settled = chunk.committed === true || chunk.pullComplete === true
      for (const cid of chunk.pieceCids) c.pullStatus[cid] = settled ? 'complete' : 'pending'
    }
  }

  const pullChunk = async (
    c: SubmitContextStatus,
    chunk: SavedChunk,
    ctx: Ctx,
    from: string | ((pieceCid: PieceCID) => string)
  ) => {
    if (chunk.pullComplete === true) return
    c.phase = 'pulling'
    seedPullStatus(c)
    emit()
    const chunkPieces = chunk.pieceCids.map((cid) => {
      const p = parsedByCid.get(cid)
      if (p == null) throw new Error(`saved chunk references unknown piece ${cid}`)
      return p.pieceCid
    })
    const result = await ctx.pull({
      pieces: chunkPieces,
      from,
      extraData: chunk.extraData,
      onProgress: (pieceCid, status) => {
        if (c.pullStatus != null) c.pullStatus[pieceCid.toString()] = status
        emit()
      },
    })
    if (result.status !== 'complete') {
      const failed = result.pieces.filter((p) => p.status !== 'complete').map((p) => p.pieceCid.toString())
      throw new Error(`provider could not pull ${failed.length} piece(s): ${failed.join(', ')}`)
    }
    chunk.pullComplete = true
    await persist()
  }

  const isTerminalRejection = (err: unknown): boolean =>
    err instanceof Error &&
    (err.name === 'WaitForAddPiecesRejectedError' || err.name === 'WaitForCreateDataSetRejectedError')

  // The upstream status waits poll for five minutes and give up — observed
  // live with a provider whose create-and-add confirmed slowly. The status
  // endpoints are idempotent GETs, so patience is re-running the wait; only
  // an on-chain REJECTION is terminal.
  const waitPatiently = async <T>(fn: () => Promise<T>): Promise<T> => {
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fn()
      } catch (err) {
        if (isTerminalRejection(err)) throw err
        lastErr = err
      }
    }
    throw lastErr
  }

  const finishChunk = (c: SubmitContextStatus, chunk: SavedChunk) => {
    chunk.committed = true
    c.pieceIds = c.chunks.flatMap((ch) => ch.pieceIds ?? [])
  }

  const commitChunk = async (c: SubmitContextStatus, chunk: SavedChunk, ctx: Ctx | undefined) => {
    if (chunk.committed === true) return
    if (chunk.txHash == null) {
      if (ctx == null) throw new Error('storage context unavailable')
      c.phase = 'committing'
      emit()
      try {
        const result = await ctx.commit({
          pieces: commitPiecesFor(chunk),
          extraData: chunk.extraData,
          onSubmitted: (txHash) => {
            // The provider accepted the submission — record the hash NOW so a
            // reload polls its status instead of ever re-posting commit.
            chunk.txHash = txHash
            c.phase = 'confirming'
            void persist()
          },
        })
        c.dataSetId = result.dataSetId.toString()
        chunk.pieceIds = result.pieceIds.map((id) => id.toString())
        finishChunk(c, chunk)
        await persist()
        return
      } catch (err) {
        // No hash recorded means the submission itself failed — surface it.
        // With a hash, the transaction is the provider's to land; fall
        // through to the same status waits a resumed run uses.
        if (chunk.txHash == null) throw err
      }
    }
    c.phase = 'confirming'
    emit()
    try {
      if (chunk.signedDataSetId == null) {
        // Create-and-add status URL shape verified against @filoz/synapse-core
        // src/sp/create-dataset-add-pieces.ts; the helper chains the data set
        // leg into the AddPieces leg itself.
        const confirmation = await waitPatiently(() =>
          sp.waitForCreateDataSetAddPieces({
            statusUrl: new URL(`/pdp/data-sets/created/${chunk.txHash}`, c.serviceURL).toString(),
          })
        )
        c.dataSetId = confirmation.dataSetId.toString()
        chunk.pieceIds = confirmation.piecesIds.map((id) => id.toString())
      } else {
        // AddPieces status URL shape verified against @filoz/synapse-core
        // src/sp/add-pieces.ts addPiecesApiRequest (the Location header).
        const confirmation = await waitPatiently(() =>
          sp.waitForAddPieces({
            statusUrl: new URL(
              `/pdp/data-sets/${chunk.signedDataSetId}/pieces/added/${chunk.txHash}`,
              c.serviceURL
            ).toString(),
          })
        )
        c.dataSetId = chunk.signedDataSetId
        chunk.pieceIds = confirmation.confirmedPieceIds.map((id) => id.toString())
      }
    } catch (err) {
      if (isTerminalRejection(err)) throw err
      // The provider's status endpoint is a side channel and can lag the
      // chain indefinitely (observed live: a data set confirmed on chain
      // while the endpoint timed out for twenty minutes). Chain state is
      // canonical — confirm from the receipt instead. The PiecesAdded event
      // is emitted only when the inner call succeeded, so its presence
      // carries the same guarantee as the three add-status signals
      // (verified: src/pdp-verifier.ts fetchAddPiecesEvent and the
      // @filoz/synapse-core/abis pdp event shapes).
      if (!(await confirmFromChain(c, chunk))) throw err
    }
    finishChunk(c, chunk)
    await persist()
  }

  const confirmFromChain = async (c: SubmitContextStatus, chunk: SavedChunk): Promise<boolean> => {
    if (chunk.txHash == null) return false
    const receipt = await synapse.client.getTransactionReceipt({ hash: chunk.txHash }).catch(() => null)
    if (receipt == null) return false
    if (receipt.status !== 'success') {
      throw new Error('commit transaction reverted on chain')
    }
    const pdpAddress = synapse.chain.contracts.pdp.address.toLowerCase()
    const event = viem
      .parseEventLogs({ abi: abis.pdp, eventName: 'PiecesAdded', logs: receipt.logs })
      .find(
        (ev) =>
          ev.address.toLowerCase() === pdpAddress &&
          (chunk.signedDataSetId == null || ev.args.setId === BigInt(chunk.signedDataSetId))
      )
    if (event == null) return false
    c.dataSetId = event.args.setId.toString()
    chunk.pieceIds = event.args.pieceIds.map((id) => id.toString())
    return true
  }

  /**
   * Drive one provider copy through every pending chunk, sequentially:
   * presign → pull → commit per chunk. Each committed chunk pins the data
   * set, so later chunks (and any resume) re-bind to it and take the plain
   * AddPieces path.
   */
  const runChunks = async (c: SubmitContextStatus, from: string | ((pieceCid: PieceCID) => string)) => {
    for (let i = 0; i < c.chunks.length; i++) {
      const chunk = c.chunks[i]
      if (chunk.committed === true) continue
      c.chunkIndex = i
      if (chunk.txHash != null) {
        // Submitted before a reload: confirmation needs no live context.
        await commitChunk(c, chunk, undefined)
        continue
      }
      const ctx = await bindCtx(c)
      await ensurePresigned(c, chunk, ctx)
      await pullChunk(c, chunk, ctx, from)
      await commitChunk(c, chunk, ctx)
    }
    c.chunkIndex = undefined
    c.phase = 'done'
    await persist()
  }

  try {
    const primary = live[0]
    const secondaries = live.slice(1)
    const sourceFor = (pieceCid: PieceCID): string => {
      const url = sourceUrlByPiece.get(pieceCid.toString())
      if (url == null) throw new Error(`no source URL for ${pieceCid.toString()}`)
      return url
    }

    // The primary completes first — every chunk pulled (parked bytes the
    // secondaries copy from) and committed. Its failure still lets resumed
    // secondaries finish confirmation work below; only fresh secondary pulls
    // need a healthy primary and fail naturally against it.
    let primaryError: unknown = null
    if (primary.phase !== 'done') {
      try {
        await runChunks(primary, sourceFor)
      } catch (err) {
        if (err instanceof SubmitBlockedError) {
          // Not a provider failure — the context stays queued and resumable
          // (a blocked throw always happens before the copy completes).
          primary.phase = 'queued'
          await persist()
          throw err
        }
        primary.phase = 'failed'
        primary.error = err instanceof Error ? err.message : String(err)
        primaryError = err
      }
    }

    // Each secondary copy is an independent on-chain data set — run them
    // concurrently, one failure never blocking the rest.
    const settled = await Promise.allSettled(
      secondaries.map((c) => (c.phase === 'done' ? Promise.resolve() : runChunks(c, primary.serviceURL)))
    )
    let blocked: SubmitBlockedError | null = null
    settled.forEach((s, i) => {
      if (s.status !== 'rejected') return
      const c = secondaries[i]
      if (s.reason instanceof SubmitBlockedError) {
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
    if (primaryError != null) throw primaryError
    if (blocked != null) throw blocked
    return state
  } finally {
    state.running = false
    emit()
  }
}
