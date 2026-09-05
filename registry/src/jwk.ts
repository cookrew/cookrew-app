import { createHash, createPublicKey, verify } from 'node:crypto'

/**
 * JWK HYGIENE — the two operations every device key passes through.
 *
 * `publicJwk` is the one that matters for what leaves the process: a device
 * posts a key it exported itself, and an exported JWK can carry `d` (the
 * private scalar) if the poster was careless. Storing what was handed over
 * would make the accounts file a key escrow. So a key is narrowed to the
 * members its curve actually needs, on the way IN, and the private half cannot
 * be written even by a caller trying to.
 *
 * `jwkThumbprint` is RFC 7638: a canonical hash of a key, used as the stable
 * name for it in the bind statement one device signs about another. It exists
 * so a vouch names a KEY rather than a JSON spelling of one — two encodings of
 * the same key must produce the same thumbprint, or a signature over the
 * spelling would be a signature over nothing.
 */

export type Jwk = Record<string, unknown>

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

/**
 * The public half of a supported key, or null.
 *
 * Only the two algorithms the ceremony verifies are accepted — EC P-256 and
 * OKP Ed25519 — because a key nothing can check is a device that can never
 * sign, stored as if it could.
 */
export function publicJwk(input: unknown): Jwk | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const jwk = input as Jwk
  if (jwk.kty === 'EC') {
    const crv = str(jwk.crv)
    const x = str(jwk.x)
    const y = str(jwk.y)
    if (crv !== 'P-256' || x === null || y === null) return null
    return { kty: 'EC', crv, x, y }
  }
  if (jwk.kty === 'OKP') {
    const crv = str(jwk.crv)
    const x = str(jwk.x)
    if (crv !== 'Ed25519' || x === null) return null
    return { kty: 'OKP', crv, x }
  }
  return null
}

/**
 * RFC 7638 thumbprint, base64url. The required members in lexicographic order,
 * no whitespace — the specification's canonical form, not a JSON.stringify of
 * whatever object happened to be in hand.
 */
export function jwkThumbprint(jwk: Jwk): string | null {
  const narrowed = publicJwk(jwk)
  if (narrowed === null) return null
  const canonical =
    narrowed.kty === 'EC'
      ? `{"crv":"${narrowed.crv as string}","kty":"EC","x":"${narrowed.x as string}","y":"${narrowed.y as string}"}`
      : `{"crv":"${narrowed.crv as string}","kty":"OKP","x":"${narrowed.x as string}"}`
  return createHash('sha256').update(canonical, 'utf8').digest('base64url')
}

/**
 * A DETACHED signature over a string, by a device's own key.
 *
 * This is not a WebAuthn ceremony and must never be confused with one: there is
 * no challenge and no user-presence flag, so it proves possession of a key and
 * nothing about a person. It is used for exactly one thing — the bind statement
 * one device signs about another — where the freshness comes from the account
 * token that carried it and the uniqueness from the new device's own id.
 */
export function verifyDetached(jwk: Jwk, message: string, signature: string): boolean {
  const key = publicJwk(jwk)
  if (key === null) return false
  try {
    const verifier = createPublicKey({ key: key as never, format: 'jwk' })
    return verify(
      key.kty === 'OKP' ? null : 'sha256',
      Buffer.from(message, 'utf8'),
      verifier,
      Buffer.from(signature, 'base64url')
    )
  } catch {
    return false
  }
}
