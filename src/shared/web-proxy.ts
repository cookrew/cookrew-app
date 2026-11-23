/**
 * A PAGE SERVED THROUGH THE COMPUTER THAT IS SIGNED IN (owner, 2026-11-23).
 *
 * The image drawn from an accessibility tree was the wrong shape for a site
 * that is mostly layout and pictures. This is the other answer, and the default
 * for a web card seen from another device: the computer fetches the page with
 * ITS OWN session, rewrites every address to a path on this computer, and the
 * device draws the real HTML and CSS in a frame. Cookies never leave; the page
 * renders as the page.
 *
 * WHAT IS REWRITTEN, and why each one: an absolute or root-relative `src`,
 * `href`, `action`, `poster` or `srcset` would otherwise leave this computer and
 * be answered by the internet with no session. `css` `url(...)` has the same
 * problem inside stylesheets. A relative address resolves against the page it
 * is on, not against this computer's path, so it is resolved first.
 *
 * WHAT IS NOT: `#fragment`, `mailto:`, `tel:`, `data:`, `blob:`, `about:` and
 * anything that would run code (`javascript:`) stay as they are — the first
 * few are not network reads, and the last is not carried at all.
 *
 * WebSocket and EventSource cannot be proxied this way. A page that needs them
 * says so (see the shim in the frame), and the person switches to the screen.
 */

/** Where a proxied request lives on this computer. */
export { PROXY_PREFIX, PROXY_SHIM, PROXY_NEEDS_SCREEN, PROXY_READ, PROXY_NAVIGATE, PROXY_INIT } from './web-proxy-frame.mjs'
import { PROXY_PREFIX } from './web-proxy-frame.mjs'
export const WEB_PROXY_ROUTE = /^\/api\/proxy\/([A-Za-z0-9_-]+)\/([^/]+)$/
export const PROXY_PAGE_MIME = 'application/vnd.cookrew.proxy-page+json'
export const PROXY_SVG_MIME = 'application/vnd.cookrew.proxy-svg+json'

export function isWebProxyUrl(raw: string): boolean {
  if (!URL.canParse(raw)) return false
  const { protocol } = new URL(raw)
  return protocol === 'http:' || protocol === 'https:'
}

/** One upstream address as a path segment: base64url, no padding. */
export function encodeTarget(url: string): string {
  const bytes = new TextEncoder().encode(url)
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The address back, or null when the segment is not one we wrote. */
export function decodeTarget(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (segment.length % 4)) % 4)
  try {
    const url = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)))
    return URL.canParse(url) ? url : null
  } catch {
    return null
  }
}

/** A target's path on this computer, under one card's prefix. */
export function proxyPath(card: string, target: string): string {
  return `${PROXY_PREFIX}/${card}/${encodeTarget(target)}`
}

/** Addresses that must never be fetched on a device's behalf. */
const PRIVATE_V4 = [
  /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
]
const METADATA = [/^169\.254\.169\.254$/, /^fd00:ec2::254$/i, /^metadata\.google\.internal$/i]

/** True when a host is this machine, its network, or a cloud metadata service. */
export function blockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return true
  if (METADATA.some((re) => re.test(host))) return true
  return PRIVATE_V4.some((re) => re.test(host))
}

/** The last two labels: enough to keep a card's own site and its subdomains together. */
export function siteOf(hostname: string): string {
  const parts = hostname.toLowerCase().split('.').filter(Boolean)
  return parts.slice(-2).join('.')
}

/** May this card's proxy fetch that address? */
export function allowedTarget(cardUrl: string, target: string): boolean {
  let page: URL
  let url: URL
  try {
    page = new URL(cardUrl)
    url = new URL(target)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (blockedHost(url.hostname)) return false
  // Its own site, or a CDN it names: anything on the public internet is fine to
  // FETCH. The session is the restriction (see cookieScope), not the address.
  return page.protocol === url.protocol || page.protocol === 'https:'
}

/** Cookies belong to a host that is the card's own site, and nowhere else. */
export function cookieScope(cardUrl: string, hostname: string): boolean {
  try {
    const page = new URL(cardUrl)
    return siteOf(page.hostname) === siteOf(hostname)
  } catch {
    return false
  }
}

const KEEP_SCHEME = /^(?:#|mailto:|tel:|data:|blob:|about:|javascript:|sms:|callto:)/i

/** One address as this computer serves it, or null when it is not a network read. */
export function rewriteUrl(raw: string, base: string, card: string): string | null {
  const value = raw.trim()
  if (value === '' || KEEP_SCHEME.test(value)) return null
  let absolute: URL
  try {
    absolute = new URL(value, base)
  } catch {
    return null
  }
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return null
  return proxyPath(card, absolute.toString())
}

const ATTR = /\b(src|href|action|poster|data-src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi
const SRCSET = /\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi

const eachSrcset = (raw: string, fn: (one: string) => string): string =>
  raw
    .split(',')
    .map((part) => {
      const [url, ...rest] = part.trim().split(/\s+/)
      const rewritten = fn(url)
      return [rewritten, ...rest].join(' ')
    })
    .join(', ')

/**
 * The page's markup with its addresses pointed at this computer. Everything else
 * is byte-for-byte the page, so its own scripts and styles run as written.
 */
const HTML_URL_ATTRS = new Set(['src', 'href', 'action', 'poster', 'data-src'])
type HtmlAttribute = { name: string; value: string }

export function rewriteHtml(html: string, base: string, card: string): string
export function rewriteHtml<T extends HtmlAttribute>(attrs: readonly T[], base: string, card: string): T[]
export function rewriteHtml(html: string | readonly HtmlAttribute[], base: string, card: string): string | HtmlAttribute[] {
  const at = (raw: string): string => rewriteUrl(raw, base, card) ?? raw
  if (typeof html !== 'string') {
    return html.map((attr) => {
      if (attr.name === 'srcset') return { ...attr, value: eachSrcset(attr.value, at) }
      return HTML_URL_ATTRS.has(attr.name) ? { ...attr, value: at(attr.value) } : attr
    })
  }
  const withAttrs = html.replace(ATTR, (whole, name: string, _quoted: string, dq?: string, sq?: string, bare?: string) => {
    const value = dq ?? sq ?? bare ?? ''
    const rewritten = at(value)
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : ''
    return `${name}=${quote}${rewritten}${quote}`
  })
  return withAttrs.replace(SRCSET, (whole, _q: string, dq?: string, sq?: string) => {
    const value = dq ?? sq ?? ''
    return `srcset="${eachSrcset(value, at)}"`
  })
}

/** `url(...)` inside a stylesheet, absolute or relative to the stylesheet. */
export function rewriteCss(css: string, base: string, card: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, quote: string, raw: string) => {
    const rewritten = rewriteUrl(raw, base, card)
    return rewritten === null ? whole : `url(${quote}${rewritten}${quote})`
  })
}
