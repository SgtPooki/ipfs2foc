/**
 * Compute a Filecoin piece commitment (PieceCID v2, FRC-0069) over a CAR
 * stream, while verifying the CAR is rooted at the expected CID.
 *
 * The hash is computed in a single streaming pass — the CAR bytes are never
 * fully buffered — so this scales to large pieces with bounded memory. This is
 * the one unavoidable full read of each object's bytes; everything downstream
 * (aggregate root, deal manifest) is metadata derived from the result.
 */

import { CarBlockIterator } from '@ipld/car'
import * as Hasher from '@web3-storage/data-segment/multihash'
import { CID } from 'multiformats/cid'
import * as Link from 'multiformats/link'
import * as Raw from 'multiformats/codecs/raw'
import { fetchCar } from './gateway.ts'
import { log } from './util.ts'

export interface PieceResult {
  /** The original IPFS CID (the CAR root). Preserved end-to-end. */
  cid: string
  /** PieceCID v2 — the value the mk20 deal declares and the SP verifies. */
  pieceCid: string
  /** CAR byte length (the piece payload size the SP will fetch). */
  rawSize: number
  /** Gateway and URL the piece commitment was computed from. */
  gateway: string
  url: string
}

/**
 * Stream a CAR through the piece hasher and the CAR parser at once. Returns the
 * PieceCID v2, the raw CAR byte length, and the CAR's declared roots.
 */
async function computePiece(
  body: ReadableStream<Uint8Array>
): Promise<{ pieceCid: string; rawSize: number; roots: CID[] }> {
  const hasher = Hasher.create()
  let rawSize = 0

  // Tap every chunk on the way to the CAR parser: feed the piece hasher and
  // count bytes. Draining the block iterator pulls the whole stream through.
  async function* tap(): AsyncIterable<Uint8Array> {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      hasher.write(chunk)
      rawSize += chunk.length
      yield chunk
    }
  }

  const reader = await CarBlockIterator.fromIterable(tap())
  // Consume all blocks so the entire CAR flows through the hasher. Block data is
  // not retained; only its passage matters for the commitment.
  // eslint-disable-next-line no-empty
  for await (const _block of reader) {
  }
  const roots = await reader.getRoots()

  const digest = hasher.digest()
  const pieceCid = (Link.create(Raw.code, digest) as CID).toString()
  return { pieceCid, rawSize, roots }
}

/**
 * Fetch a CID as a CAR from the first working gateway, compute its PieceCID v2,
 * and verify the CAR root matches the requested CID (i.e. no re-chunking).
 * Tries gateways in order; the first that yields a valid, root-matching CAR
 * wins. The winning gateway's URL is what the SP will later pull from.
 */
export async function fetchAndComputePiece(cid: string, gateways: string[]): Promise<PieceResult> {
  const expected = CID.parse(cid)
  const errors: string[] = []

  for (const gateway of gateways) {
    try {
      const { url, body } = await fetchCar(gateway, cid)
      const { pieceCid, rawSize, roots } = await computePiece(body)

      const rootMatch = roots.some((r) => r.equals(expected) || r.toString() === cid)
      if (!rootMatch) {
        throw new Error(
          `CAR root mismatch: expected ${cid}, CAR declares [${roots.map((r) => r.toString()).join(', ')}]`
        )
      }

      return { cid, pieceCid, rawSize, gateway, url }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${gateway}: ${message}`)
      log(`  ! ${cid} via ${gateway} failed: ${message}`)
    }
  }

  throw new Error(`all gateways failed for ${cid}\n    ${errors.join('\n    ')}`)
}
