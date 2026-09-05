import type { RegistryKeys } from './canvas-token'

/**
 * The registry's signing key, cached for an hour.
 *
 * An hour is a compromise between two failures. Too short and every phone
 * arriving on a LAN with no WAN gets refused because the Mac could not refresh
 * a key that has not changed in months. Too long and a revoked session id
 * keeps opening the canvas after the owner pressed revoke — which is why the
 * revoked list rides along with the key rather than living behind a second
 * call, and why a verification failure buys exactly ONE immediate refetch.
 *
 * One refetch, not a retry loop: a token that fails against a fresh key is a
 * bad token, and hammering the registry on every bad token is a way to turn a
 * refused phone into an outage.
 */

const CACHE_MS = 60 * 60 * 1000

export type RegistryKeysDeps = {
  readonly origin: string
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>
  readonly now?: () => number
}

export type RegistryKeyCache = {
  /** The cached keys, fetching when cold or stale. Null if unreachable. */
  readonly keys: () => Promise<RegistryKeys | null>
  /** Force one refresh — used once, after a signature fails. */
  readonly refresh: () => Promise<RegistryKeys | null>
}

const looksLikeKeys = (value: unknown): value is RegistryKeys => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.jwk !== 'object' || record.jwk === null) return false
  return record.revoked === undefined || Array.isArray(record.revoked)
}

export const createRegistryKeyCache = (deps: RegistryKeysDeps): RegistryKeyCache => {
  const http = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const now = deps.now ?? Date.now
  const url = `${deps.origin.replace(/\/+$/, '')}/v2/keys`

  let cached: RegistryKeys | null = null
  let readAt = 0
  let inflight: Promise<RegistryKeys | null> | null = null

  const fetchKeys = async (): Promise<RegistryKeys | null> => {
    try {
      const response = await http(url)
      if (!response.ok) return null
      const parsed: unknown = await response.json()
      if (!looksLikeKeys(parsed)) return null
      const keys: RegistryKeys = {
        jwk: parsed.jwk,
        revoked: (parsed.revoked ?? []).filter((id): id is string => typeof id === 'string')
      }
      cached = keys
      readAt = now()
      return keys
    } catch {
      // Unreachable is not "no key": the cached one, if any, still verifies.
      return null
    }
  }

  const once = (): Promise<RegistryKeys | null> => {
    // Coalesced, so ten phones arriving together make one request.
    if (!inflight) inflight = fetchKeys().finally(() => void (inflight = null))
    return inflight
  }

  return {
    keys: async () => {
      if (cached && now() - readAt < CACHE_MS) return cached
      return (await once()) ?? cached
    },
    refresh: async () => (await once()) ?? cached
  }
}
