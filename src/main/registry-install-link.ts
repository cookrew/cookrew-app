/**
 * Recognise a marketplace install link (R21).
 *
 * A canvas browser card showing the registry navigates to
 * https://<registry-host>/install/<presetId>. Cookrew intercepts that
 * navigation and hands main the preset id — the same canonical-https shape as
 * the phone handoff, and for the same reason: a real URL that works in any
 * browser, which this app happens to understand.
 *
 * TWO PROPERTIES, both deliberate.
 *
 * ONE PRESET ID CROSSES. Not the URL, not the query, not the fragment, not the
 * page. A marketplace page carries analytics params and whatever else its
 * author wants; none of that is the app's business, and a boundary that passes
 * "the URL" is a boundary whose width is decided by the other side.
 *
 * RECOGNISING IS NOT INSTALLING. This returns an id. Main owns download,
 * signature verification and the review sheet, and the user owns the decision.
 * A web page must never be able to cause an install by being navigated to —
 * only to ASK, and asking is what a recognised link is.
 *
 * Written adversarially because the input is a URL from a page the user does
 * not control: exact host match (never a suffix), https outside loopback, an
 * exact path shape, and a content-address id. Anything else is not a link.
 * Fails closed on every axis, including "no registry configured".
 */

/** `sha256:` + 64 hex, the content address of team.json (manifest sketch). */
const PRESET_ID = /^sha256:[0-9a-f]{64}$/i

/** Loopback is not a shared network, so the https rule has no work to do. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * The preset id an install URL names, or null if it is not an install URL.
 *
 * `registryHosts` are host[:port] values, compared exactly and
 * case-insensitively. Empty means no registry is configured, which recognises
 * nothing rather than anything.
 */
export function presetIdFromInstallUrl(
  rawUrl: string,
  registryHosts: readonly string[]
): string | null {
  if (registryHosts.length === 0) return null

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    // A navigation event carries whatever the page put in it. Unparseable is
    // simply "not an install link", never a crash in the browser card.
    return null
  }

  // Userinfo can smuggle the registry host into a URL served by someone else:
  // https://registry.example@attacker.com/... has host attacker.com. Nothing
  // legitimate needs it here, so its presence alone disqualifies.
  if (url.username !== '' || url.password !== '') return null

  const host = url.host.toLowerCase()
  const allowed = registryHosts.some((candidate) => candidate.toLowerCase() === host)
  if (!allowed) return null

  // https everywhere except loopback, where the dev registry lives and there is
  // no network to intercept.
  const isLoopback = LOOPBACK.has(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) return null

  // Exactly /install/<id>, with an optional trailing slash. Extra segments are
  // a different route, not a sloppy version of this one.
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  if (segments.length !== 2 || segments[0] !== 'install') return null

  const id = decodeURIComponent(segments[1])
  if (!PRESET_ID.test(id)) return null

  // Content addresses compare by value: two spellings of one digest must not
  // become two presets.
  return id.toLowerCase()
}

/**
 * Does this URL have the SHAPE of an install link, regardless of whether its
 * host is one we recognise?
 *
 * Used only to decide whether an owner deserves an explanation. It must not be
 * used to decide anything about trust: shape is what an attacker controls, and
 * the recognised-host list is the only thing that grants anything. Kept
 * deliberately narrow — path shape only, never the host — so it cannot drift
 * into a second, laxer recognition path.
 */
export function looksLikeInstallLink(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    return /^\/install\/[^/]+\/?$/.test(parsed.pathname)
  } catch {
    return false
  }
}
