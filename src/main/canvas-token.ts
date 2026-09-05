import { createPublicKey, verify } from 'node:crypto'

/**
 * THE TOKEN THE PHONE ARRIVES WITH, CHECKED WITHOUT ASKING ANYONE.
 *
 * cookrew.dev signs a short-lived token naming {account, device, scope,
 * audience}; this Mac verifies it offline against the registry's published
 * key. Offline is the requirement, not an optimisation: a phone opening the
 * canvas on the LAN must work when the house has no internet, and a door that
 * phones home to authorise every visitor is a door that closes when the WAN
 * blinks.
 *
 * THE WIRE SHAPE IS THE REGISTRY'S, EXACTLY — two segments, not a JWS:
 *
 *     base64url(JSON.stringify(claims)) + '.' + base64url(ed25519 signature)
 *
 * and the signature is over the BASE64URL BODY STRING, not over the raw JSON
 * bytes. No header and therefore no `alg` field, which is a small mercy: a
 * token that names its own verifier is how "alg: none" got into the world, and
 * this format cannot express the mistake. Mirrors registry/src/v2-tokens.ts;
 * the two are one format described in two places, and the test at the bottom
 * of tests/admission.test.ts builds a token the registry's way to prove it.
 *
 * EVERY CLAIM IS CHECKED, and each refusal is distinct HERE even though the
 * registry deliberately conflates them for its own callers. The difference is
 * who is listening: the registry answers a stranger, so telling them which
 * claim failed is a probe; this Mac answers itself, in its own log, and the
 * phone gets one sentence either way.
 *
 * `aud` is what stops a token minted for the Mac mini from opening the
 * MacBook — the owner's own token, replayed at the wrong machine, is the
 * realistic attack here, not a forgery.
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
  /**
   * DEVICE IDS AND SESSION JTIS IN ONE LIST. The registry publishes both here
   * because this list is the ONLY revocation channel a verifier working
   * offline can see — so a token is refused when either its device or its own
   * id is on it, and a reader must not assume the entries are one kind.
   */
  readonly revoked: readonly string[]
}

export type CanvasTokenExpectation = {
  readonly username: string
  readonly deviceId: string
  readonly phoneDeviceId: string
  readonly now: number
}

const asClaims = (payload: Record<string, unknown>): CanvasClaims | null => {
  const { sub, scope, aud, dev, exp, jti } = payload
  if (typeof sub !== 'string' || sub === '') return null
  if (typeof scope !== 'string' || scope === '') return null
  if (typeof aud !== 'string' || aud === '') return null
  if (typeof dev !== 'string' || dev === '') return null
  if (typeof jti !== 'string' || jti === '') return null
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
  return { sub, scope, aud, dev, exp, jti }
}

export const verifyCanvasToken = (
  token: string,
  keys: RegistryKeys,
  expect: CanvasTokenExpectation
): CanvasTokenResult => {
  const [body, signature, ...rest] = token.split('.')
  if (!body || !signature || rest.length > 0) return { ok: false, reason: 'malformed' }

  // SIGNATURE BEFORE CLAIMS, so an unsigned token can never be read for the
  // shape of the refusal it provokes. Over the base64url body string itself —
  // the registry signs the segment it transmits, not the JSON behind it.
  let signed = false
  try {
    const key = createPublicKey({ key: keys.jwk as never, format: 'jwk' })
    signed = verify(
      null,
      Buffer.from(body, 'utf8'),
      key,
      Buffer.from(signature, 'base64url')
    )
  } catch {
    signed = false
  }
  if (!signed) return { ok: false, reason: 'bad_signature' }

  let payload: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    payload = typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    payload = null
  }
  if (!payload) return { ok: false, reason: 'malformed' }

  const claims = asClaims(payload)
  if (!claims) return { ok: false, reason: 'malformed' }

  if (claims.sub !== expect.username) return { ok: false, reason: 'wrong_account' }
  if (claims.scope !== 'canvas') return { ok: false, reason: 'wrong_scope' }
  if (claims.aud !== expect.deviceId) return { ok: false, reason: 'wrong_desktop' }
  if (claims.dev !== expect.phoneDeviceId) return { ok: false, reason: 'wrong_phone' }
  if (claims.exp <= expect.now) return { ok: false, reason: 'expired' }
  if (keys.revoked.includes(claims.jti) || keys.revoked.includes(claims.dev)) {
    return { ok: false, reason: 'revoked' }
  }
  return { ok: true, claims }
}
