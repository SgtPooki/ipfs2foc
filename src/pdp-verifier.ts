/**
 * Read-only PDPVerifier access for reconciling a data set's on-chain pieces.
 *
 * The provider's add can land the on-chain AddPieces and then fail a later
 * bookkeeping step, returning a 5xx without a tx hash. Reading the data set's
 * active pieces lets submission confirm whether an aggregate root is already
 * committed before adding it again.
 */

import { createPublicClient, http } from 'viem'
import { CID } from 'multiformats/cid'

const PDP_VERIFIER: Record<'calibration' | 'mainnet', `0x${string}`> = {
  calibration: '0x85e366Cf9DD2c0aE37E963d9556F5f4718d6417C',
  mainnet: '0xBADd0B92C1c71d02E7d520f64c0876538fa2557F',
}

const GET_ACTIVE_PIECES = [
  {
    type: 'function',
    name: 'getActivePieces',
    stateMutability: 'view',
    inputs: [
      { name: 'setId', type: 'uint256' },
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [
      { name: 'pieces', type: 'tuple[]', components: [{ name: 'data', type: 'bytes' }] },
      { name: 'pieceIds', type: 'uint256[]' },
      { name: 'hasMore', type: 'bool' },
    ],
  },
] as const

/** The set of active piece CIDs (v2 strings) on a data set, paged from the contract. */
export async function activePieceCids(
  rpcUrl: string,
  network: 'calibration' | 'mainnet',
  dataSetId: number
): Promise<Set<string>> {
  const client = createPublicClient({ transport: http(rpcUrl) })
  const address = PDP_VERIFIER[network]
  const out = new Set<string>()
  const pageSize = 100n
  for (let offset = 0n; ; offset += pageSize) {
    const [pieces, , hasMore] = (await client.readContract({
      address,
      abi: GET_ACTIVE_PIECES,
      functionName: 'getActivePieces',
      args: [BigInt(dataSetId), offset, pageSize],
    })) as [Array<{ data: `0x${string}` }>, bigint[], boolean]
    for (const p of pieces) {
      out.add(CID.decode(hexToBytes(p.data)).toString())
    }
    if (!hasMore) {
      return out
    }
  }
}

function hexToBytes(hex: `0x${string}`): Uint8Array {
  const body = hex.slice(2)
  const bytes = new Uint8Array(body.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
