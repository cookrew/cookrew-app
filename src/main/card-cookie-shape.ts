/**
 * A CARD COOKIE AS THE VAULT KEEPS IT (card-cookie-vault.ts).
 *
 * Storage.getCookies answers with more than Storage.setCookies takes back
 * (size, session, priority, sameParty, sourceScheme, sourcePort). The vault
 * keeps only the fields setCookies needs to make the same cookie again, so an
 * unknown field a newer Chrome adds can never make Chrome refuse the restore.
 *
 * One rule carries the meaning across: a cookie whose domain has no leading dot
 * is HOST-ONLY. It goes back by url, not by domain; given a domain, Chrome
 * would make it a domain cookie, and refuse a `__Host-` one outright.
 */

import type { HeadlessCookie } from './headless-chrome'

/** CDP's Network.CookiePartitionKey; an older Chrome spelled it as the top-level site alone. */
export type CookiePartitionKey = string | { readonly topLevelSite: string; readonly hasCrossSiteAncestor: boolean }

export type CookieSameSite = 'Strict' | 'Lax' | 'None'

export interface VaultCookie {
  readonly name: string
  readonly value: string
  /** As Chrome reports it: `.site` for a domain cookie, the bare host for a host-only one. */
  readonly domain: string
  readonly path: string
  /** Seconds since the epoch. Absent: a session cookie, and it goes back as one. */
  readonly expires?: number
  readonly httpOnly: boolean
  readonly secure: boolean
  readonly sameSite?: CookieSameSite
  readonly partitionKey?: CookiePartitionKey
}

const SAME_SITE: ReadonlySet<string> = new Set(['Strict', 'Lax', 'None'])

function partitionKeyOf(raw: unknown): CookiePartitionKey | undefined {
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (typeof raw !== 'object' || raw === null) return undefined
  const { topLevelSite, hasCrossSiteAncestor } = raw as Record<string, unknown>
  if (typeof topLevelSite !== 'string' || typeof hasCrossSiteAncestor !== 'boolean') return undefined
  return { topLevelSite, hasCrossSiteAncestor }
}

/** The cookie in a CDP Network.Cookie (or a kept one), or null when it is not one Chrome could take back. */
export function vaultCookieFrom(raw: unknown): VaultCookie | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  if (typeof c.name !== 'string' || typeof c.value !== 'string') return null
  if (typeof c.domain !== 'string' || c.domain.length === 0) return null
  if (typeof c.path !== 'string' || !c.path.startsWith('/')) return null
  const persistent = c.session !== true && typeof c.expires === 'number' && Number.isFinite(c.expires) && c.expires > 0
  const sameSite = typeof c.sameSite === 'string' && SAME_SITE.has(c.sameSite) ? (c.sameSite as CookieSameSite) : undefined
  const partitionKey = partitionKeyOf(c.partitionKey)
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    ...(persistent ? { expires: c.expires as number } : {}),
    httpOnly: c.httpOnly === true,
    secure: c.secure === true,
    ...(sameSite ? { sameSite } : {}),
    ...(partitionKey ? { partitionKey } : {})
  }
}

/** Gone by the clock: Chrome would drop it, so it is never set. */
export function isExpired(cookie: VaultCookie, nowMs: number): boolean {
  return cookie.expires !== undefined && cookie.expires * 1000 <= nowMs
}

/** The Storage.setCookies param that makes this same cookie again. */
export function cookieParamFor(cookie: VaultCookie): HeadlessCookie {
  const hostOnly = !cookie.domain.startsWith('.')
  const where = hostOnly
    ? { url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain}${cookie.path}` }
    : { domain: cookie.domain }
  return {
    name: cookie.name,
    value: cookie.value,
    ...where,
    path: cookie.path,
    ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {})
  }
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * Which cookie this is, for "is it already there": name, domain, path and
 * partition. The leading dot is ignored, so a host-only and a domain cookie of
 * one name count as the same one: when in doubt the vault leaves it alone.
 */
export function cookieKey(cookie: {
  readonly name: string
  readonly domain?: string
  readonly url?: string
  readonly path?: string
  readonly partitionKey?: CookiePartitionKey
}): string {
  const domain = (cookie.domain ?? hostOf(cookie.url)).replace(/^\./, '').toLowerCase()
  const partition = typeof cookie.partitionKey === 'object' ? cookie.partitionKey.topLevelSite : (cookie.partitionKey ?? '')
  return JSON.stringify([cookie.name, domain, cookie.path ?? '/', partition])
}
