/**
 * Read-only PDPVerifier access for reconciling a data set's on-chain state.
 *
 * All ABI + contract addresses come from `@filoz/synapse-core`. The
 * high-level wrappers (`getActivePieces`, `dataSetLive`, etc.) are used
 * where they exist; the few getters not yet wrapped fall back to a typed
 * `readContract` call against the canonical `abis.pdp` ABI.
 */

import { type Client, type Hash, type Transport, createPublicClient, http, parseEventLogs } from 'viem'
import { getBlockNumber, getTransactionReceipt, readContract, waitForTransactionReceipt } from 'viem/actions'
import { pdp as PDP_ABI } from '@filoz/synapse-core/abis'
import { type Chain as SynapseChain, calibration, mainnet } from '@filoz/synapse-core/chains'
import {
  dataSetLive,
  getActivePieceCount,
  getActivePieces as synapseGetActivePieces,
  getNextChallengeEpoch,
} from '@filoz/synapse-core/pdp-verifier'
import { hexToPieceCID } from '@filoz/synapse-core/piece'

function chainFor(network: 'calibration' | 'mainnet'): SynapseChain {
  return network === 'mainnet' ? mainnet : calibration
}

/**
 * Build a public client typed to the synapse-core `Chain` (which carries the
 * contract addresses). viem's `createPublicClient` widens the chain field to
 * `Chain | undefined`; the cast narrows it back so the synapse-core PDP
 * helpers (which require a non-undefined chain) accept it.
 */
function clientFor(rpcUrl: string, network: 'calibration' | 'mainnet'): Client<Transport, SynapseChain> {
  return createPublicClient({ chain: chainFor(network), transport: http(rpcUrl) }) as unknown as Client<
    Transport,
    SynapseChain
  >
}

/** The set of active piece CIDs (v2 strings) on a data set, paged from the contract. */
export async function activePieceCids(
  rpcUrl: string,
  network: 'calibration' | 'mainnet',
  dataSetId: number
): Promise<Set<string>> {
  const client = clientFor(rpcUrl, network)
  const out = new Set<string>()
  const pageSize = 100n
  for (let offset = 0n; ; offset += pageSize) {
    const { pieces, hasMore } = await synapseGetActivePieces(client, {
      dataSetId: BigInt(dataSetId),
      offset,
      limit: pageSize,
    })
    for (const p of pieces) out.add(p.cid.toString())
    if (!hasMore) return out
  }
}

/** Base URL of the PDP explorer for a network. */
export function explorerBase(network: 'calibration' | 'mainnet'): string {
  return `https://pdp.vxb.ai/${network}`
}

/** Explorer deep link to a data set. */
export function explorerDataSetUrl(network: 'calibration' | 'mainnet', dataSetId: number | string): string {
  return `${explorerBase(network)}/dataset/${dataSetId}`
}

/** Explorer deep link to a piece by its PieceCID v2. */
export function explorerPieceUrl(network: 'calibration' | 'mainnet', pieceCid: string): string {
  return `${explorerBase(network)}/piece/${pieceCid}`
}

export interface ProofHealth {
  /** True iff the data set is currently live (not deleted). */
  live: boolean
  /** Current chain epoch (block number). */
  currentEpoch: bigint
  /** Last accepted proof-of-possession epoch, or null when never proven. */
  lastProvenEpoch: bigint | null
  /** Epoch the SP must submit the next proof by. */
  nextChallengeEpoch: bigint
  /** Configured slack window between challenge issuance and proof deadline. */
  challengeFinality: bigint
  /** Count of pieces currently active in the data set. */
  activePieceCount: bigint
  /**
   * True iff the SP has produced at least one valid proof for this data set
   * at or after `maxAddEpoch`. PoP samples pseudo-random chunks of the data
   * set; a valid proof requires holding the bytes.
   */
  provenSinceAdd: boolean
  /** True iff `nextChallengeEpoch` is not yet in the past. */
  inGoodStanding: boolean
}

/**
 * Read the data set's proof-of-possession health from chain. Eight RPC calls
 * fired in parallel, so the wall-clock cost is one round-trip regardless of
 * how many CIDs are in the data set.
 */
export async function dataSetProofHealth(
  rpcUrl: string,
  network: 'calibration' | 'mainnet',
  dataSetId: number,
  maxAddEpoch: bigint | null
): Promise<ProofHealth> {
  const client = clientFor(rpcUrl, network)
  const chain = chainFor(network)
  const setId = BigInt(dataSetId)

  const [live, lastProvenRaw, nextChallengeMaybe, challengeFinality, noProvenSentinel, activePieceCount, currentEpoch] =
    await Promise.all([
      dataSetLive(client, { dataSetId: setId }),
      readContract(client, {
        abi: PDP_ABI,
        address: chain.contracts.pdp.address,
        functionName: 'getDataSetLastProvenEpoch',
        args: [setId],
      }) as Promise<bigint>,
      getNextChallengeEpoch(client, { dataSetId: setId }),
      readContract(client, {
        abi: PDP_ABI,
        address: chain.contracts.pdp.address,
        functionName: 'getChallengeFinality',
      }) as Promise<bigint>,
      readContract(client, {
        abi: PDP_ABI,
        address: chain.contracts.pdp.address,
        functionName: 'NO_PROVEN_EPOCH',
      }) as Promise<bigint>,
      getActivePieceCount(client, { dataSetId: setId }),
      getBlockNumber(client),
    ])

  const lastProvenEpoch = lastProvenRaw === noProvenSentinel ? null : lastProvenRaw
  // `getNextChallengeEpoch` returns null when no challenge has been scheduled
  // yet (fresh data set, pre-first-proving-period). Treat that as "in good
  // standing" since the SP cannot have missed a deadline that does not exist.
  const nextChallenge = nextChallengeMaybe ?? currentEpoch
  const provenSinceAdd =
    lastProvenEpoch != null && (maxAddEpoch == null || lastProvenEpoch >= maxAddEpoch)
  const inGoodStanding = nextChallenge >= currentEpoch

  return {
    live,
    currentEpoch,
    lastProvenEpoch,
    nextChallengeEpoch: nextChallenge,
    challengeFinality,
    activePieceCount,
    provenSinceAdd,
    inGoodStanding,
  }
}

/**
 * The on-chain PiecesAdded event for a given data set, parsed from an
 * AddPieces tx receipt. PDPVerifier emits one event per AddPieces call
 * carrying parallel arrays of pieceIds + pieceCids (verified against the
 * `pdp` ABI in `@filoz/synapse-core/abis`, event `PiecesAdded(uint256
 * indexed setId, uint256[] pieceIds, struct Cids.Cid[] pieceCids)`).
 *
 * Returns the event matching `dataSetId`, with its pieceIds and pieceCid
 * v2 strings, plus the receipt's block number. Returns null when the
 * receipt carries no matching event (a reverted inner call leaves no
 * PiecesAdded log even when the tx itself succeeded).
 */
export interface AddPiecesEvent {
  blockNumber: bigint
  pieceIds: bigint[]
  pieceCids: string[]
}

export async function fetchAddPiecesEvent(
  rpcUrl: string,
  network: 'calibration' | 'mainnet',
  dataSetId: number,
  txHash: string
): Promise<AddPiecesEvent | null> {
  const client = clientFor(rpcUrl, network)
  const chain = chainFor(network)
  const receipt = await waitForTransactionReceipt(client, { hash: txHash as Hash })
  const events = parseEventLogs({
    abi: PDP_ABI,
    eventName: 'PiecesAdded',
    logs: receipt.logs,
  })
  const target = BigInt(dataSetId)
  const match = events.find(
    (ev) => ev.address.toLowerCase() === chain.contracts.pdp.address.toLowerCase() && ev.args.setId === target
  )
  if (match == null) return null
  const pieceCids = match.args.pieceCids.map((p) => hexToPieceCID(p.data).toString())
  return {
    blockNumber: receipt.blockNumber,
    pieceIds: [...match.args.pieceIds],
    pieceCids,
  }
}

/**
 * Fetch receipts for a batch of tx hashes and return the highest block
 * number observed. `report` uses this to find the latest AddPieces epoch
 * across all committed aggregates: PoPs accepted at or after this block
 * prove the SP held the bytes after the run's final add.
 */
export async function maxBlockOfTxHashes(
  rpcUrl: string,
  network: 'calibration' | 'mainnet',
  txHashes: string[]
): Promise<bigint | null> {
  if (txHashes.length === 0) return null
  const client = clientFor(rpcUrl, network)
  const chunkSize = 16
  let max: bigint | null = null
  for (let i = 0; i < txHashes.length; i += chunkSize) {
    const chunk = txHashes.slice(i, i + chunkSize)
    const receipts = await Promise.allSettled(chunk.map((h) => getTransactionReceipt(client, { hash: h as Hash })))
    for (const r of receipts) {
      if (r.status !== 'fulfilled') continue
      if (max == null || r.value.blockNumber > max) max = r.value.blockNumber
    }
  }
  return max
}
