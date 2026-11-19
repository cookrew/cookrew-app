import { randomBytes, timingSafeEqual } from 'node:crypto'
import type http from 'node:http'
import { SEALED_MARKER } from '../shared/remote-unlock'

/**
 * WHAT SAYS A REQUEST CAME OUT OF THE SEALED SESSION.
 *
 * The terminus hands what it opens to this same server over loopback, where it looks
 * like any bridged request. Only a request the relay could not read may carry a
 * password, so the difference has to be something the relay cannot write: a value
 * made at launch that lives in this process and is never sent anywhere but loopback.
 * Plain bridged requests have the header taken off in canvas-bridge.ts as well.
 *
 * It says how a request travelled and nothing about who sent it: the pairing token
 * inside the session still has to pass.
 */

const PROOF = randomBytes(32).toString('base64url')

export const sealProofHeaders = (): Record<string, string> => ({ [SEALED_MARKER]: PROOF })

export function carriesSealProof(request: Pick<http.IncomingMessage, 'headers'>): boolean {
  const said = request.headers[SEALED_MARKER]
  if (typeof said !== 'string') return false
  const [held, given] = [Buffer.from(PROOF), Buffer.from(said)]
  return held.length === given.length && timingSafeEqual(held, given)
}

/**
 * WHICH DEVICE A SEALED SESSION'S HANDSHAKE PROVED, for a request out of a device-mode
 * session (a watch, another desktop): the terminus sets it from the handshake and takes
 * any copy a caller sent off the request (canvas-seal-terminus.ts · innerHeaders). A
 * code-mode session (a phone, the console) names no device this way: the relay's word
 * on who it is proves nothing. Believed only beside the seal's proof, which nothing
 * outside this process can write.
 */
export const SEALED_PEER_HEADER = 'x-cookrew-seal-peer'

export function sealedPeerOf(request: Pick<http.IncomingMessage, 'headers'>): string | null {
  const said = request.headers[SEALED_PEER_HEADER]
  return typeof said === 'string' && said.length > 0 && carriesSealProof(request) ? said : null
}

/**
 * WHETHER A REQUEST CAME OUT OF A COOKREW-SEAL/2 SESSION (code or device mode), not v1's: the
 * terminus sets it on every v2 stream's inner request and takes any copy a caller sent off
 * the request, on v1 and v2 alike (canvas-seal-terminus.ts · innerHeaders). Believed only
 * beside the seal's proof. A remembered password is issued and taken only on such a request
 * (remote-unlock.ts).
 */
export const SEALED_V2_HEADER = 'x-cookrew-seal-v2'

export function sealedV2Of(request: Pick<http.IncomingMessage, 'headers'>): boolean {
  return request.headers[SEALED_V2_HEADER] === '1' && carriesSealProof(request)
}

/**
 * WHAT SAYS A REQUEST CAME DOWN THE RELAY LINE, in the clear: the canvas relay's
 * own dialer adds it (index.ts), and nothing else does. The direct WebRTC link
 * and the sealed session's inner requests carry the relay marker too, so the
 * marker alone cannot tell them apart from the relay. A per-launch value, as
 * the seal's proof is, and taken off whatever arrives (canvas-bridge.ts).
 */
export const RELAY_LINE_MARKER = 'x-cookrew-relay-line'

const LINE = randomBytes(32).toString('base64url')

export const relayLineHeaders = (): Record<string, string> => ({ [RELAY_LINE_MARKER]: LINE })

export function cameOverRelayLine(request: Pick<http.IncomingMessage, 'headers'>): boolean {
  const said = request.headers[RELAY_LINE_MARKER]
  if (typeof said !== 'string') return false
  const [held, given] = [Buffer.from(LINE), Buffer.from(said)]
  return held.length === given.length && timingSafeEqual(held, given)
}
