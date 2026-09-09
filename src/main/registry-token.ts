import { createPublicKey, verify } from 'node:crypto'

/**
 * A REGISTRY TOKEN AT THE DOOR — sign in with cookrew.dev, not with a key.
 *
 * The registry mints a short-lived `call` token for ONE door (its `aud` is
 * the door's published name, `@handle/team`), signed with the registry's
 * ed25519 key. A door verifies it with the registry's PUBLIC key — fetched
 * once, cached for an hour — and never has to ask the registry whether a
 * caller is who they say. The token's format is exactly what
 * registry/src/identity.ts writes: `${base64url(JSON claims)}.${base64url(sig)}`,
 * the signature over the ASCII bytes of the body.
 *
 * Everything that is not the one accepted shape is null. Which check failed
 * is not something a stranger gets to learn (the ceremony's own rule), and
 * the gate answers every null with the same 401.
 */

export interface RegistryClaims {
  sub: string
  scope: 'call'
  exp: number
  aud: string
}

/** Where the registry's public JWK comes from. Injected so a test needs no registry. */
export interface RegistryKeySource {
  /** The current key, or null when the registry cannot give one. */
  fetch(): Promise<Record<string, unknown> | null>
}

export interface RegistryTokenVerifier {
  /** The caller's handle, or null. `aud` is THIS door's published name. */
  verify(token: string, aud: string): Promise<{ sub: string } | null>
}

/** A cookrew.dev handle — the only sub a registry token may carry. */
export const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

/** How long a fetched key is trusted before it is asked for again. */
export const REGISTRY_KEY_TTL_MS = 60 * 60 * 1000

/** The registry's key, where `GET /v1/identity/key` publishes it. */
export function registryKeyOverHttp(origin: string): RegistryKeySource {
  return {
    fetch: async () => {
      const answer = await fetch(new URL('/v1/identity/key', origin), {
        signal: AbortSignal.timeout(5000)
      })
      if (!answer.ok) return null
      const body = (await answer.json()) as { jwk?: unknown }
      return isEd25519Jwk(body.jwk) ? body.jwk : null
    }
  }
}

function isEd25519Jwk(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const jwk = value as Record<string, unknown>
  return jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && typeof jwk.x === 'string'
}

/** The signature holds under this key: the body is the registry's own words. */
export function registrySignatureHolds(token: string, jwk: Record<string, unknown>): boolean {
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
export function registryClaimsFor(token: string, aud: string, now: number): RegistryClaims | null {
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
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now) return null
  if (typeof claims.aud !== 'string' || claims.aud !== aud) return null
  if (typeof claims.sub !== 'string' || !HANDLE.test(claims.sub)) return null
  return { sub: claims.sub, scope: 'call', exp: claims.exp, aud: claims.aud }
}

/** The pure check: signature under `jwk`, then the claims, for `aud`, at `now`. */
export function verifyRegistryToken(
  token: string,
  jwk: Record<string, unknown>,
  aud: string,
  now: number
): { sub: string } | null {
  if (!registrySignatureHolds(token, jwk)) return null
  const claims = registryClaimsFor(token, aud, now)
  return claims === null ? null : { sub: claims.sub }
}

/**
 * The verifier a door holds: one cached key, refreshed after an hour, and
 * refetched ONCE when a signature fails — a registry that rotated its key
 * would otherwise refuse every honest caller until the hour was up. A token
 * that fails on its claims does not refetch: the key was fine.
 */
export function createRegistryTokenVerifier(options: {
  keys: RegistryKeySource
  now?: () => number
  ttlMs?: number
}): RegistryTokenVerifier {
  const now = options.now ?? ((): number => Date.now())
  const ttl = options.ttlMs ?? REGISTRY_KEY_TTL_MS
  let cached: { jwk: Record<string, unknown>; at: number } | null = null

  const currentKey = async (force: boolean): Promise<Record<string, unknown> | null> => {
    if (!force && cached !== null && now() - cached.at < ttl) return cached.jwk
    try {
      const jwk = await options.keys.fetch()
      cached = jwk === null ? null : { jwk, at: now() }
      return jwk
    } catch {
      cached = null
      return null
    }
  }

  return {
    verify: async (token, aud) => {
      if (typeof token !== 'string' || token.length === 0) return null
      const first = await currentKey(false)
      const holds = first !== null && registrySignatureHolds(token, first)
      const key = holds ? first : await currentKey(true)
      if (key === null || !registrySignatureHolds(token, key)) return null
      const claims = registryClaimsFor(token, aud, now())
      return claims === null ? null : { sub: claims.sub }
    }
  }
}
