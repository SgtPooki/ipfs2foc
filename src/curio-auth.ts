/**
 * CurioAuth header signing for the mk20 market API.
 *
 * Curio authenticates each mk20 request with a header
 * `CurioAuth <keyType>:<base64(addressBytes)>:<base64(filecoinSignature)>`,
 * where the signature covers
 * `sha256(addressBytes ‖ METHOD ‖ requestPath ‖ RFC3339-minute)`. The verifier
 * tolerates the previous and next minute, so a synced clock is enough.
 *
 * FOC clients hold an Ethereum key, so this uses the Filecoin `delegated`
 * (f410) scheme: the address is the EAM-namespaced delegated address of the eth
 * account, and the signature is `secp256k1(keccak256(authMessage))` recovered to
 * that eth address. The serialized signature is prefixed with the Filecoin
 * delegated signature type byte.
 *
 * Scheme verified against filecoin-project/lotus lib/sigs/delegated and Curio
 * market/mk20/auth.go.
 */

import { createHash } from 'node:crypto'
import { type Hex, hexToBytes, keccak256 } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'

const PROTOCOL_DELEGATED = 0x04
const EAM_ACTOR_ID = 0x0a // Ethereum Address Manager actor, leb128(10) == 0x0a
const SIG_TYPE_DELEGATED = 0x03

export interface CurioSigner {
  /** Filecoin f410 delegated address for the eth account (e.g. f410f…). */
  address: string
  /** Build the Authorization header value for a request. */
  header(method: string, requestPath: string, at?: Date): Promise<string>
}

/** Address bytes for an eth address as a Filecoin f410 delegated address. */
function delegatedAddressBytes(ethAddress: Hex): Uint8Array {
  const ethBytes = hexToBytes(ethAddress) // 20 bytes
  const bytes = new Uint8Array(2 + ethBytes.length)
  bytes[0] = PROTOCOL_DELEGATED
  bytes[1] = EAM_ACTOR_ID
  bytes.set(ethBytes, 2)
  return bytes
}

/** Filecoin RFC3339 timestamp truncated to the minute, e.g. 2026-05-27T12:34:00Z. */
function rfc3339Minute(date: Date): string {
  const floored = new Date(Math.floor(date.getTime() / 60000) * 60000)
  return floored.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function createCurioSigner(privateKey: Hex): CurioSigner {
  const account = privateKeyToAccount(privateKey)
  const addrBytes = delegatedAddressBytes(account.address)

  return {
    address: account.address, // eth form; the f410 string is derivable but unused on the wire
    async header(method: string, requestPath: string, at: Date = new Date()): Promise<string> {
      const message = Buffer.concat([
        Buffer.from(addrBytes),
        Buffer.from(method.toUpperCase(), 'utf8'),
        Buffer.from(requestPath, 'utf8'),
        Buffer.from(rfc3339Minute(at), 'utf8'),
      ])
      const authDigest = createHash('sha256').update(message).digest()

      // delegated verify keccak256-hashes the message before ecrecover.
      const hash = keccak256(authDigest)
      const signature = await sign({ hash, privateKey })

      const sig65 = new Uint8Array(65)
      sig65.set(hexToBytes(signature.r), 0)
      sig65.set(hexToBytes(signature.s), 32)
      sig65[64] = Number(signature.yParity) // recovery id 0 or 1
      const fcSig = new Uint8Array(1 + sig65.length)
      fcSig[0] = SIG_TYPE_DELEGATED
      fcSig.set(sig65, 1)

      return `CurioAuth delegated:${Buffer.from(addrBytes).toString('base64')}:${Buffer.from(fcSig).toString('base64')}`
    },
  }
}
