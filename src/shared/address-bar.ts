/**
 * Address-bar resolution: what the user TYPED → what the pane NAVIGATES to.
 *
 * Typing "GitHub.com" and pressing Enter used to store that raw string as the
 * tab's url, which is not a URL — the pane went blank. Resolution completes a
 * bare host into a real URL, keeps the schemes a browser pane legitimately
 * sits on, and sends anything that is not addressable to a search instead of
 * a dead navigation.
 *
 * Pure and dependency-free so it unit-tests without Electron and can run on
 * either side of the socket.
 */

/** Prefix a search query is appended to (encoded). */
export const SEARCH_URL = 'https://duckduckgo.com/?q='

/**
 * Schemes a browser pane may be pointed at. Anything else a user types
 * (mailto:, custom app schemes) would hand the pane to whatever local handler
 * claims it, so it is treated as search text rather than a navigation.
 */
const NAVIGABLE_SCHEMES = new Set(['http:', 'https:', 'about:', 'file:'])

/** Any leading "scheme:" — including ones we will not navigate to. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * host:port, matched BEFORE scheme handling: `new URL('localhost:3000')` does
 * not throw, it parses as scheme "localhost", so port-suffixed hosts have to
 * be claimed here or they resolve to nonsense.
 */
const HOST_PORT = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\]):\d{1,5}(?=[/?#]|$)/i

/** A dotted name with a plausible last label, e.g. example.co.uk/path. */
const DOTTED_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?=[/?#]|$)/i

/** Dotted quad, which reads as a host even though its last label is numeric. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?=[:/?#]|$)/

/** Hosts served over plain http in practice: loopback, LAN, dev servers. */
const INSECURE_HOST = /^(?:localhost|0\.0\.0\.0|\[::1\]|.+\.local)$/i

/**
 * Resolve typed address-bar text to a navigable URL, or null when there is
 * nothing to navigate to (empty input).
 */
export function resolveAddress(typed: string): string | null {
  const text = typed.trim()
  if (text === '') return null

  if (HOST_PORT.test(text) || DOTTED_HOST.test(text) || IPV4.test(text) || isBareLoopback(text)) {
    return parseOrSearch(`${schemeFor(hostOf(text))}//${text}`, text)
  }

  if (HAS_SCHEME.test(text)) {
    const parsed = tryParse(text)
    if (parsed && NAVIGABLE_SCHEMES.has(parsed.protocol)) return parsed.href
    return searchFor(text)
  }

  return searchFor(text)
}

/** Search URL for text that is not an address. */
export function searchFor(query: string): string {
  return `${SEARCH_URL}${encodeURIComponent(query)}`
}

function isBareLoopback(text: string): boolean {
  return /^localhost(?=[:/?#]|$)/i.test(text)
}

/** The host portion of scheme-less input, for the http/https decision. */
function hostOf(text: string): string {
  const authority = text.split(/[/?#]/, 1)[0] ?? text
  // Strip a :port, but not the colons inside a bracketed IPv6 literal.
  return authority.startsWith('[') ? authority : (authority.split(':', 1)[0] ?? authority)
}

function schemeFor(host: string): string {
  return INSECURE_HOST.test(host) || IPV4.test(host) ? 'http:' : 'https:'
}

function parseOrSearch(candidate: string, original: string): string {
  return tryParse(candidate)?.href ?? searchFor(original)
}

function tryParse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
