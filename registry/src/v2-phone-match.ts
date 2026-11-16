import { createHash } from 'node:crypto'
import { jwkThumbprint } from '../../src/shared/jwk-thumbprint'

/**
 * WHICH PHONE IS ASKING TO BE KEPT, in six digits a person compares (owner
 * 2026-11-17, security review): the Mac's "A phone joined: <name>. Keep it?"
 * shows the joining phone's match number beside a name the joiner chose, and
 * the phone shows its own on its screen. A stranger who spent a leaked QR
 * first holds another key, so another number.
 *
 * The number is the first four bytes of SHA-256 over the key's RFC 7638
 * thumbprint (its base64url text), big-endian, modulo a million, six digits.
 * The Go twin is phone/core/pair · MatchCode; tests pin both to one vector.
 */
export function phoneMatchCode(jwk: Record<string, unknown>): string | null {
  const thumbprint = jwkThumbprint(jwk)
  if (thumbprint === null) return null
  const digest = createHash('sha256').update(thumbprint, 'utf8').digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

/** What a phone signs to join with a phone's code: proof it holds the key it names (security review 2026-11-17). */
export const phoneJoinMessage = (code: string, deviceId: string): string => `cookrew-join/1 ${code} ${deviceId.toLowerCase()}`
