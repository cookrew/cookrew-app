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
