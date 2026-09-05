import { createPublicKey, verify } from 'node:crypto'

/**
 * A v2 CALL TOKEN AT THE DOOR — the identity-v2 sign-in, verified offline.
 *
 * cookrew.dev mints a ten-minute `call` token naming ONE door (`aud` is the
 * published `@handle/team`), one PERSON (`sub` is the username), one DEVICE
 * (`dev`) and, when a seat admitted them, the SEAT (`seat`). The format is
 * exactly what registry/src/v2-tokens.ts writes:
 * `${base64url(JSON claims)}.${base64url(ed25519 sig)}`, the signature over
 * the ASCII bytes of the body.
 *
 * WHY A SECOND VERIFIER AND NOT AN EDIT TO registry-token.ts. The v1 verifier
 * answers a different question — a handle and nothing else, from a key served
 * at a different path — and doors on the old path keep using it unchanged
 * through phase 6. Widening it would have made one function answer two wire
 * contracts, and the first thing to drift would have been which fields are
 * REQUIRED. `seat` in particular must be readable as "absent", never as
 * "wildcard": the whole 403 depends on that distinction.
 *
 * WHAT MAKES THIS DIFFERENT FROM v1, in three lines:
 *   · the key comes from `/v2/keys`, which publishes a REVOCATION LIST beside
 *     the JWK — the only thing an offline verifier can be told about a device
 *     or a session that was cut off after its token was minted;
 *   · the sub is a username, and it is never `acct-`-prefixed on the wire
 *     (that prefix is the DOOR's namespace, added when the caller is seated);
 *   · `scope` must be exactly 'call'; a session token at a door is a token
 *     being spent somewhere it was not minted for.
 *
 * Everything that is not the one accepted shape is null. Which check failed is
 * not something a stranger gets to learn, and the gate answers every null with
 * the same 401.
 */

/** What the door learns from a good token. */
export interface V2CallIdentity {
  /** The account, no `@`. THE PERSON — the identity the door seats. */
  username: string
  /** The device that asked. A fact about presence, never about permission. */
  dev: string
  /** The seat that admitted them, or null when none did. */
  seat: string | null
}

/** The claims a v2 call token may carry. */
export interface V2CallClaims {
  sub: string
  dev: string
  scope: 'call'
  exp: number
  jti: string
  aud: string
  seat?: string
}

/** What `/v2/keys` publishes: the public half and everything cut off. */
export interface V2KeyMaterial {
  jwk: Record<string, unknown>
  /** Device ids and session ids whose tokens are refused however well they verify. */
  revoked: readonly string[]
}

/** Where the key comes from. Injected so a test needs no registry. */
export interface V2KeySource {
  /** The current material, or null when the registry cannot give it. */
  fetch(): Promise<V2KeyMaterial | null>
}

export interface V2CallTokenVerifier {
  /** The caller, or null. `aud` is THIS door's published name. */
  verify(token: string, aud: string): Promise<V2CallIdentity | null>
}

/** A cookrew.dev username — the only sub a v2 call token may carry. */
export const V2_USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
/** The audience a call token names: `@handle/team`, as the registry checks it. */
export const V2_AUDIENCE =
  /^@[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
/** How long fetched material is trusted before it is asked for again. */
export const V2_KEY_TTL_MS = 60 * 60 * 1000

/** The registry this door verifies against. Overridable for a test deployment. */
export function v2RegistryOrigin(): string {
  return process.env.COOKREW_REGISTRY || 'https://cookrew.dev'
}

function isEd25519Jwk(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const jwk = value as Record<string, unknown>
  return jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && typeof jwk.x === 'string'
}

/** `GET /v2/keys` — the JWK and the revoked list, in one answer. */
export function v2KeysOverHttp(origin: string): V2KeySource {
  return {
    fetch: async () => {
      const answer = await fetch(new URL('/v2/keys', origin), {
        signal: AbortSignal.timeout(5000)
      })
      if (!answer.ok) return null
      const body = (await answer.json()) as { jwk?: unknown; revoked?: unknown }
      if (!isEd25519Jwk(body.jwk)) return null
      // A malformed revoked list reads as EMPTY, not as a refusal to serve.
      // The alternative — treating an unreadable list as "trust nothing" —
      // takes every honest caller down with one bad deploy of the registry.
      const revoked = Array.isArray(body.revoked)
        ? body.revoked.filter((id): id is string => typeof id === 'string')
        : []
      return { jwk: body.jwk, revoked }
    }
  }
}

/** The signature holds under this key: the body is cookrew.dev's own words. */
export function v2SignatureHolds(token: string, jwk: Record<string, unknown>): boolean {
  const parts = token.split('.')
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) return false
  if (!isEd25519Jwk(jwk)) return false
  try {
    return verify(
      null,
      Buffer.from(parts[0], 'utf8'),
      createPublicKey({ key: jwk as never, format: 'jwk' }),
      Buffer.from(parts[1], 'base64url')
    )
  } catch {
    return false
  }
}

/** The claims, if the body is the one shape and they are good for this door now. */
export function v2CallClaimsFor(token: string, aud: string, now: number): V2CallClaims | null {
  const [body] = token.split('.')
  if (!body) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const claims = parsed as Record<string, unknown>
  if (claims.scope !== 'call') return null
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now) {
    return null
  }
  if (typeof claims.aud !== 'string' || !V2_AUDIENCE.test(claims.aud) || claims.aud !== aud) {
    return null
  }
  if (typeof claims.sub !== 'string' || !V2_USERNAME.test(claims.sub)) return null
  if (typeof claims.dev !== 'string' || claims.dev.length === 0) return null
  if (typeof claims.jti !== 'string' || claims.jti.length === 0) return null
  // A SEAT IS AN ID OR IT IS NOT THERE. Anything else is a token somebody
  // shaped by hand, and a door must not read it as a seat — nor may it read
  // absence as one, which is what the 403 in served-endpoints.ts turns on.
  if (claims.seat !== undefined && (typeof claims.seat !== 'string' || claims.seat === '')) {
    return null
  }
  return {
    sub: claims.sub,
    dev: claims.dev,
    scope: 'call',
    exp: claims.exp,
    jti: claims.jti,
    aud: claims.aud,
    ...(claims.seat === undefined ? {} : { seat: claims.seat as string })
  }
}

/** Was this token cut off? Device id and session id are both listed. */
export function v2Revoked(claims: V2CallClaims, revoked: readonly string[]): boolean {
  return revoked.includes(claims.dev) || revoked.includes(claims.jti)
}

/** The pure check: signature under `material.jwk`, then the claims, for `aud`. */
export function verifyV2CallToken(
  token: string,
  material: V2KeyMaterial,
  aud: string,
  now: number
): V2CallIdentity | null {
  if (!v2SignatureHolds(token, material.jwk)) return null
  const claims = v2CallClaimsFor(token, aud, now)
  if (claims === null || v2Revoked(claims, material.revoked)) return null
  return { username: claims.sub, dev: claims.dev, seat: claims.seat ?? null }
}

/**
 * The verifier a door holds: one cached answer, refreshed after an hour, and
 * refetched ONCE on a signature failure OR a revoked hit.
 *
 * Both refetch for the same reason — the cached copy may simply be OLD. A
 * rotated key would refuse every honest caller until the hour was up; a
 * revocation list an hour behind would refuse a device the owner UN-revoked,
 * or (worse in the other direction) a stale list is the only window in which a
 * cut-off device still works, so shortening it costs one request. A token that
 * fails on its CLAIMS does not refetch: the key was fine and the token was not.
 */
export function createV2CallTokenVerifier(options: {
  keys: V2KeySource
  now?: () => number
  ttlMs?: number
}): V2CallTokenVerifier {
  const now = options.now ?? ((): number => Date.now())
  const ttl = options.ttlMs ?? V2_KEY_TTL_MS
  let cached: { material: V2KeyMaterial; at: number } | null = null

  const material = async (force: boolean): Promise<V2KeyMaterial | null> => {
    if (!force && cached !== null && now() - cached.at < ttl) return cached.material
    try {
      const fetched = await options.keys.fetch()
      cached = fetched === null ? null : { material: fetched, at: now() }
      return fetched
    } catch {
      cached = null
      return null
    }
  }

  return {
    verify: async (token, aud) => {
      if (typeof token !== 'string' || token.length === 0) return null
      if (!V2_AUDIENCE.test(aud)) return null
      const first = await material(false)
      const stale =
        first === null ||
        !v2SignatureHolds(token, first.jwk) ||
        // A revoked hit on a CACHED list is the second reason to look again.
        (() => {
          const claims = v2CallClaimsFor(token, aud, now())
          return claims !== null && v2Revoked(claims, first.revoked)
        })()
      const current = stale ? await material(true) : first
      if (current === null) return null
      return verifyV2CallToken(token, current, aud, now())
    }
  }
}
