import { createPublicKey, verify } from 'node:crypto'

/**
 * THE TOKEN THE PHONE ARRIVES WITH, CHECKED WITHOUT ASKING ANYONE.
 *
 * cookrew.dev signs a short-lived token naming {account, scope, audience,
 * device}; this Mac verifies it offline against the registry's published key.
 * Offline is the requirement, not an optimisation: a phone opening the canvas
 * on the LAN must work when the house has no internet, and a door that phones
 * home to authorise every visitor is a door that closes when the WAN blinks.
 *
 * Compact JWS, EdDSA over Ed25519 — `<header>.<payload>.<signature>`, all
 * base64url. That is the shape the registry half emits; it is stated here in
 * one place because two programs have to agree on it.
 *
 * EVERY CLAIM IS CHECKED, and each refusal is distinct. `aud` is what stops a
 * token minted for the Mac mini from opening the MacBook — the owner's own
 * token, replayed at the wrong machine, is the realistic attack here, not a
 * forgery.
 */

export type CanvasClaims = {
  readonly sub: string
  readonly scope: string
  readonly aud: string
  readonly dev: string
  readonly exp: number
  readonly jti: string
}

export type CanvasTokenRefusal =
  | 'malformed'
  | 'bad_algorithm'
  | 'bad_signature'
  | 'wrong_account'
  | 'wrong_scope'
  | 'wrong_desktop'
  | 'wrong_phone'
  | 'expired'
  | 'revoked'

export type CanvasTokenResult =
  | { readonly ok: true; readonly claims: CanvasClaims }
  | { readonly ok: false; readonly reason: CanvasTokenRefusal }

export type RegistryKeys = {
  readonly jwk: Record<string, unknown>
  readonly revoked: readonly string[]
}

export type CanvasTokenExpectation = {
  readonly username: string
  readonly deviceId: string
  readonly phoneDeviceId: string
  readonly now: number
}

const decodeJson = (segment: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const asClaims = (payload: Record<string, unknown>): CanvasClaims | null => {
  const { sub, scope, aud, dev, exp, jti } = payload
  if (typeof sub !== 'string' || typeof scope !== 'string') return null
  if (typeof aud !== 'string' || typeof dev !== 'string' || typeof jti !== 'string') return null
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
  return { sub, scope, aud, dev, exp, jti }
}

export const verifyCanvasToken = (
  token: string,
  keys: RegistryKeys,
  expect: CanvasTokenExpectation
): CanvasTokenResult => {
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return { ok: false, reason: 'malformed' }
  }
  const [headerPart, payloadPart, signaturePart] = parts
  const header = decodeJson(headerPart)
  const payload = decodeJson(payloadPart)
  if (!header || !payload) return { ok: false, reason: 'malformed' }
  // `alg` is read to be REFUSED, never to select an algorithm — letting the
  // token name its own verifier is how "alg: none" got into the world.
  if (header.alg !== 'EdDSA') return { ok: false, reason: 'bad_algorithm' }

  const claims = asClaims(payload)
  if (!claims) return { ok: false, reason: 'malformed' }

  // Signature BEFORE claims, so an unsigned token can never be read for the
  // shape of the refusal it provokes.
  let signed = false
  try {
    const key = createPublicKey({ key: keys.jwk as never, format: 'jwk' })
    signed = verify(
      null,
      Buffer.from(`${headerPart}.${payloadPart}`, 'utf8'),
      key,
      Buffer.from(signaturePart, 'base64url')
    )
  } catch {
    signed = false
  }
  if (!signed) return { ok: false, reason: 'bad_signature' }

  if (claims.sub !== expect.username) return { ok: false, reason: 'wrong_account' }
  if (claims.scope !== 'canvas') return { ok: false, reason: 'wrong_scope' }
  if (claims.aud !== expect.deviceId) return { ok: false, reason: 'wrong_desktop' }
  if (claims.dev !== expect.phoneDeviceId) return { ok: false, reason: 'wrong_phone' }
  if (claims.exp <= expect.now) return { ok: false, reason: 'expired' }
  if (keys.revoked.includes(claims.jti)) return { ok: false, reason: 'revoked' }
  return { ok: true, claims }
}
