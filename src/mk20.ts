/**
 * mk20 market client: build an aggregate AddPiece deal and talk to a Curio
 * provider's `/market/mk20` API.
 *
 * The deal carries no payload. It describes a PODSI aggregate whose sub-pieces
 * are HTTP pull sources (gateway CAR URLs); the provider pulls and assembles
 * them. CIDs serialize as `{"/": "<cid>"}` (the dag-json form go-cid emits), the
 * identifier is a ULID, and `PDPV1.ExtraData` is base64 (a Go `[]byte`).
 *
 * Wire shape verified against Curio market/mk20 (types.go, retrieval_v1.go,
 * client/http_client.go).
 */

import type { CurioSigner } from './curio-auth.ts'

const MARKET_PATH = '/market/mk20'
const AGGREGATE_TYPE_V1 = 1

/** Deal lifecycle state this tool tracks, derived from the mk20 status response. */
export type DealLifecycle = 'submitted' | 'committed' | 'failed' | 'unknown'

export interface SubPieceInput {
  pieceCid: string
  urls: string[]
}

export interface AddPieceDealInput {
  /** Filecoin address string that owns the data set (e.g. t410… on calibration). */
  clientAddress: string
  dataSetId: number
  /** FWSS record keeper contract address. */
  recordKeeper: string
  /** FWSS AddPieces authorization blob (EIP-712), as raw bytes. */
  extraData: Uint8Array
  /** PODSI aggregate root PieceCID v2. */
  aggregateRootPieceCid: string
  subPieces: SubPieceInput[]
  indexing: boolean
  announcePayload: boolean
}

interface DealJson {
  identifier: string
  client: string
  data: unknown
  products: unknown
}

const cidJson = (cid: string): { '/': string } => ({ '/': cid })

/** Build the JSON `Deal` body for an aggregate AddPiece. */
export function buildAddPieceDeal(input: AddPieceDealInput): DealJson {
  return {
    identifier: ulid(),
    client: input.clientAddress,
    data: {
      piece_cid: cidJson(input.aggregateRootPieceCid),
      format: { aggregate: { type: AGGREGATE_TYPE_V1 } },
      source_aggregate: {
        pieces: input.subPieces.map((sp) => ({
          piece_cid: cidJson(sp.pieceCid),
          format: { car: {} },
          source_http: {
            urls: sp.urls.map((url, i) => ({ url, headers: {}, priority: i, fallback: i > 0 })),
          },
        })),
      },
    },
    products: {
      pdp_v1: {
        add_piece: true,
        data_set_id: input.dataSetId,
        record_keeper: input.recordKeeper,
        extra_data: Buffer.from(input.extraData).toString('base64'),
      },
      retrieval_v1: {
        indexing: input.indexing,
        announce_payload: input.announcePayload,
        announce_piece: input.announcePayload,
      },
    },
  }
}

export interface SubmitResult {
  identifier: string
  status: number
}

export interface StatusResult {
  state: string
  errorMsg: string
  lifecycle: DealLifecycle
}

export class Mk20Client {
  #baseUrl: string
  #signer: CurioSigner

  constructor(providerUrl: string, signer: CurioSigner) {
    this.#baseUrl = providerUrl.replace(/\/+$/, '') + MARKET_PATH
    this.#signer = signer
  }

  /** POST /deal. Returns the deal identifier on acceptance; throws on rejection. */
  async submitDeal(deal: DealJson): Promise<SubmitResult> {
    const path = `${MARKET_PATH}/deal`
    const res = await fetch(`${this.#baseUrl}/deal`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: await this.#signer.header('POST', path),
      },
      body: JSON.stringify(deal),
    })
    if (!res.ok) {
      throw new Error(`mk20 deal rejected: HTTP ${res.status} ${await res.text()}`)
    }
    return { identifier: deal.identifier, status: res.status }
  }

  /**
   * GET /contracts. An authenticated read used to confirm connectivity and that
   * the CurioAuth header is accepted, without any on-chain action.
   */
  async contracts(): Promise<string[]> {
    const path = `${MARKET_PATH}/contracts`
    const res = await fetch(`${this.#baseUrl}/contracts`, {
      headers: { authorization: await this.#signer.header('GET', path) },
    })
    if (!res.ok) {
      throw new Error(`mk20 contracts: HTTP ${res.status} ${await res.text()}`)
    }
    const body = (await res.json()) as { contracts?: string[] | null }
    return body.contracts ?? []
  }

  /** GET /status/{id}, mapped to a lifecycle state. */
  async status(identifier: string): Promise<StatusResult> {
    const path = `${MARKET_PATH}/status/${identifier}`
    const res = await fetch(`${this.#baseUrl}/status/${identifier}`, {
      headers: { authorization: await this.#signer.header('GET', path) },
    })
    if (!res.ok) {
      throw new Error(`mk20 status: HTTP ${res.status} ${await res.text()}`)
    }
    const body = (await res.json()) as { pdp_v1?: { status?: string; errorMsg?: string } }
    const state = body.pdp_v1?.status ?? 'unknown'
    return { state, errorMsg: body.pdp_v1?.errorMsg ?? '', lifecycle: mapLifecycle(state) }
  }
}

/**
 * Map an mk20 deal state to the migration lifecycle. mk20 reports
 * accepted/processing/sealing/indexing while the provider pulls and assembles
 * sub-pieces, then complete once AddPiece is on-chain. "parked" is internal to
 * the provider and is not surfaced here, so in-flight states map to `submitted`.
 */
function mapLifecycle(state: string): DealLifecycle {
  switch (state) {
    case 'complete':
      return 'committed'
    case 'failed':
      return 'failed'
    case 'accepted':
    case 'uploading':
    case 'processing':
    case 'sealing':
    case 'indexing':
      return 'submitted'
    default:
      return 'unknown'
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Generate a ULID: 48-bit timestamp + 80-bit randomness, Crockford base32. */
function ulid(): string {
  let time = Date.now()
  const timeChars = new Array<string>(10)
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = CROCKFORD[time % 32]
    time = Math.floor(time / 32)
  }
  const random = new Array<string>(16)
  for (let i = 0; i < 16; i++) {
    random[i] = CROCKFORD[Math.floor(Math.random() * 32)]
  }
  return timeChars.join('') + random.join('')
}
