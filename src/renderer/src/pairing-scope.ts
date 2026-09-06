/**
 * WHICH MAC THIS CREDENTIAL IS FOR, AND HOW IT ARRIVED.
 *
 * Reach v2.1 collapsed pairing to ONE credential: the token the Mac mints,
 * persists and rotates with `cookrew mobile --rotate`. Two consequences land
 * on the companion, and both are storage questions rather than UI ones.
 *
 * THE TOKEN ARRIVES IN A FRAGMENT. The printed URL is
 * `https://cookrew.dev/relay/@user/desktop/<id>/#pair=<token>`. A fragment is
 * never put on the wire, so cookrew.dev — which serves this bundle and relays
 * the line to the Mac — never sees the credential that authorises the phone at
 * the Mac. That property is only worth something if the fragment does not
 * survive the boot: a token left in the address bar is in every screenshot,
 * every share sheet, every `document.referrer` and every reload.
 *
 * ONE ORIGIN NOW HOSTS MANY MACS. Direct, the origin WAS the desktop, so a
 * single `cookrew-pairing-token` key could not be ambiguous. Under
 * cookrew.dev every desktop the owner has shares an origin and therefore a
 * localStorage — so one key would hand Mac B the token minted for Mac A. That
 * is not merely a 401 that reads as "randomly unpaired"; it is a credential
 * sent to a machine it was never minted for.
 *
 * Everything here is pure, because both rules are get-them-wrong-quietly rules
 * and a rule that needs a browser to test is a rule that gets tested once.
 */

/**
 * The shape the Mac mints: `randomBytes(24).toString('base64url')`, 32 chars.
 *
 * The bounds are wide enough to survive a change of width on the Mac and tight
 * enough that a fragment carrying something else — a router path, a truncated
 * paste, an old six-character key — is refused HERE rather than stored and
 * then refused by the Mac one screen later.
 */
export const PAIRING_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/

export const isPairingToken = (value: string): boolean => PAIRING_TOKEN_SHAPE.test(value)

/**
 * The key a DIRECT pairing has always used. Unchanged, and unchangeable: every
 * phone already paired over the LAN or the tailnet has its token under it, and
 * renaming it would unpair all of them for nothing.
 */
export const ROOT_TOKEN_KEY = 'cookrew-pairing-token'

/** `cr_token:<desktop id>` — one Mac, one key, under the shared origin. */
export const DESKTOP_TOKEN_PREFIX = 'cr_token:'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const DESKTOP_IN_BASE = new RegExp(`/relay/@[^/]+/desktop/(${UUID})(?:/|$)`, 'i')

/**
 * The desktop id inside a relay prefix, or null when the base is not one.
 *
 * Read from the BASE the server injected (`COOKREW_BASE`), never from
 * `location.pathname` — the base is the prefix this bundle was served under
 * and came down the bridge; the pathname is whatever the page has navigated
 * to since.
 */
export const desktopIdFromBase = (base: string): string | null => {
  const match = DESKTOP_IN_BASE.exec(base)
  return match ? match[1].toLowerCase() : null
}

/**
 * Where this client's token lives.
 *
 * At the root: today's key, so nothing about an existing LAN pairing changes.
 * Under a relay prefix: keyed by desktop. And when the prefix is one we cannot
 * read, keyed by the prefix itself — an unreadable base is still not the root,
 * and falling back to the root key there would serve this Mac whichever token
 * the last direct pairing left behind.
 */
export const tokenKeyForBase = (base: string): string => {
  const trimmed = base.replace(/\/+$/, '')
  if (trimmed.length === 0) return ROOT_TOKEN_KEY
  return `${DESKTOP_TOKEN_PREFIX}${desktopIdFromBase(trimmed) ?? trimmed}`
}

/** The query parameter a DIRECT pairing URL carries: `?token=`. */
export const TOKEN_PARAM = 'token'

/** The fragment parameter the canonical relay URL carries: `#pair=`. */
export const PAIR_PARAM = 'pair'

/**
 * A fragment, split into the router-ish prefix and its parameters.
 *
 * Both `#pair=` and `#/pair=` are accepted because both are things a human
 * will end up holding: the first is what the Mac prints, the second is what a
 * hash router leaves behind when the same link is opened in an app that has
 * one. Treating them as different links would mean a QR that works and a
 * pasted URL that does not, for no reason the reader could ever see.
 */
const splitHash = (hash: string): { prefix: string; params: URLSearchParams } => {
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  const prefix = body.startsWith('/') ? '/' : ''
  return { prefix, params: new URLSearchParams(prefix ? body.slice(1) : body) }
}

/** The pairing token carried by a fragment, or null when there is none. */
export const tokenFromFragment = (hash: string): string | null => {
  if (!hash || !hash.includes(PAIR_PARAM)) return null
  try {
    const found = splitHash(hash).params.get(PAIR_PARAM)
    return found && isPairingToken(found) ? found : null
  } catch {
    // A fragment that will not parse is not a pairing link. Never a throw:
    // this runs on the boot path, before anything is on screen to report it.
    return null
  }
}

/** The same fragment with the token taken out, keeping whatever else it held. */
export const stripPairFragment = (hash: string): string => {
  if (!hash) return hash
  try {
    const { prefix, params } = splitHash(hash)
    if (!params.has(PAIR_PARAM)) return hash
    params.delete(PAIR_PARAM)
    const rest = params.toString()
    return rest.length === 0 ? '' : `#${prefix}${rest}`
  } catch {
    return hash
  }
}

/**
 * This page's URL with every credential removed, or null when it carried none.
 *
 * Null rather than the unchanged href on purpose: the caller writes a history
 * entry with it, and replacing the state of a page that was already clean is a
 * pointless mutation of the user's history on every single boot.
 */
export const scrubPairingFromUrl = (href: string): string | null => {
  try {
    const url = new URL(href)
    const hadToken = url.searchParams.has(TOKEN_PARAM)
    const nextHash = stripPairFragment(url.hash)
    if (!hadToken && nextHash === url.hash) return null
    url.searchParams.delete(TOKEN_PARAM)
    url.hash = nextHash
    return url.toString()
  } catch {
    return null
  }
}
