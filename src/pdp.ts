/**
 * Curio PDP HTTP client for the pull + aggregate-add migration path.
 *
 * Two calls, both authorized by an FWSS `extraData` blob (the provider's HTTP
 * layer is open; the on-chain `eth_call` of AddPieces is the real gate):
 *
 *   POST /pdp/piece/pull              — provider pulls each sub-piece CAR from
 *                                       its sourceUrl (the redirect server → gateway),
 *                                       verifies CommP, parks it. Idempotent:
 *                                       re-POST the same body to poll status.
 *   POST /pdp/data-sets/{id}/pieces   — add one aggregate piece over the parked
 *                                       sub-pieces; one on-chain AddPieces.
 *
 * No Authorization header: a default public PDP provider runs NullAuth (service
 * "public"). Authorization is carried entirely by `extraData`.
 */

import type { Hex } from 'viem'

export type PullPieceStatus = 'pending' | 'inProgress' | 'retrying' | 'complete' | 'failed'

export interface PullPieceInput {
  pieceCid: string
  sourceUrl: string
}

export interface PullResponse {
  status: PullPieceStatus
  pieces: Array<{ pieceCid: string; status: PullPieceStatus }>
}

export class PdpClient {
  #base: string

  constructor(serviceURL: string) {
    this.#base = serviceURL.replace(/\/+$/, '')
  }

  /**
   * Submit (or poll, when re-sent with the same body) a pull request. The body
   * is the idempotency key via `sha256(extraData)` + dataSetId, so reuse one
   * `extraData` per batch for both the submit and its status polls.
   */
  async pull(body: { extraData: Hex; dataSetId: number; pieces: PullPieceInput[] }): Promise<PullResponse> {
    const res = await fetch(`${this.#base}/pdp/piece/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ extraData: body.extraData, dataSetId: body.dataSetId, pieces: body.pieces }),
    })
    if (res.status === 429) {
      const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '60', 10)
      throw new PullBackpressure(retryAfter)
    }
    if (!res.ok) {
      throw new Error(`pull: HTTP ${res.status} ${await res.text()}`)
    }
    return (await res.json()) as PullResponse
  }

  /**
   * Add one aggregate piece over already-parked sub-pieces. Returns the AddPieces
   * transaction hash (from the Location header) and a status URL to poll.
   */
  async addAggregate(
    dataSetId: number,
    aggregateRootPieceCid: string,
    subPieceCids: string[],
    extraData: Hex
  ): Promise<{ txHash: string; statusUrl: string }> {
    const res = await fetch(`${this.#base}/pdp/data-sets/${dataSetId}/pieces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pieces: [
          {
            pieceCid: aggregateRootPieceCid,
            subPieces: subPieceCids.map((subPieceCid) => ({ subPieceCid })),
          },
        ],
        extraData,
      }),
    })
    if (!res.ok) {
      throw new Error(`addPieces: HTTP ${res.status} ${await res.text()}`)
    }
    const location = res.headers.get('location') ?? ''
    const txHash = location.split('/').pop() ?? ''
    return { txHash, statusUrl: location }
  }

  /** Poll an AddPieces transaction to confirmation. */
  async addStatus(dataSetId: number, txHash: string): Promise<{ done: boolean; ok: boolean }> {
    const res = await fetch(`${this.#base}/pdp/data-sets/${dataSetId}/pieces/added/${txHash}`)
    if (res.status === 404) {
      return { done: false, ok: false } // not yet observed
    }
    if (!res.ok) {
      throw new Error(`addStatus: HTTP ${res.status} ${await res.text()}`)
    }
    const body = (await res.json()) as { txStatus?: string; confirmed?: boolean }
    const done = body.confirmed === true || body.txStatus === 'confirmed' || body.txStatus === 'failed'
    return { done, ok: body.confirmed === true || body.txStatus === 'confirmed' }
  }
}

/** Thrown when the provider returns 429; carries the suggested retry delay. */
export class PullBackpressure extends Error {
  retryAfterSeconds: number
  constructor(retryAfterSeconds: number) {
    super(`pull backpressure; retry after ${retryAfterSeconds}s`)
    this.retryAfterSeconds = retryAfterSeconds
  }
}
