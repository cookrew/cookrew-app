import { createHash, randomBytes } from 'node:crypto'
import { jwkThumbprint } from '../../src/shared/jwk-thumbprint'

/**
 * WHICH PHONE IS ASKING TO BE KEPT, in six digits a person compares (owner
 * 2026-11-17, security review): the Mac's "A phone joined: <name>. Keep it?"
 * shows the joining phone's match number beside a name the joiner chose, and
 * the phone shows its own on its screen. A stranger who spent a leaked QR
 * first holds another key, so another number.
 *
 * SALTED, SO NO KEY CAN BE GROUND TO MATCH (security review 2026-11-17): a
 * key's thumbprint is public (every pass names it), and six digits of it alone
 * fall to a million tries in seconds. The salt is drawn by the registry when
 * the join arrives, after the joiner's key is fixed, and handed to that phone
 * only; a stranger racing with a leaked QR commits to a key before seeing it.
 *
 * The number is the first four bytes of SHA-256 over
 * `cookrew-match/2 <salt> <thumbprint>`, big-endian, modulo a million, six
 * digits. The Go twin is phone/core/pair · MatchCode; tests pin both to one vector.
 */
export function phoneMatchCode(jwk: Record<string, unknown>, salt: string): string | null {
  const thumbprint = jwkThumbprint(jwk)
  if (thumbprint === null || salt === '') return null
  const digest = createHash('sha256').update(`cookrew-match/2 ${salt} ${thumbprint}`, 'utf8').digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

/** A fresh salt for one join's match number: sixteen random bytes, base64url. */
export const matchSalt = (): string => randomBytes(16).toString('base64url')

/** What a phone signs to join with a phone's code: proof it holds the key it names (security review 2026-11-17). */
export const phoneJoinMessage = (code: string, deviceId: string): string => `cookrew-join/1 ${code} ${deviceId.toLowerCase()}`
