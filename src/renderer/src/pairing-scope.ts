/**
 * WHICH MACHINE THIS CREDENTIAL IS FOR, AND HOW IT ARRIVED.
 *
 * A machine takes ONE credential from a browser: the token it mints, persists
 * and rotates with `cookrew mobile --rotate` (or the per-device token it mints
 * for one admitted browser). Two consequences land on the page, and both are
 * storage questions rather than UI ones.
 *
 * A CREDENTIAL IN A LINK ARRIVES IN A FRAGMENT. `#pair=<token>` on a link
 * `cookrew mobile --token` printed, pasted on a machine's own page; `#code=`
 * on the console link a machine draws on its own screen
 * (console/handed-code.ts). A fragment is never put on the wire, so no host
 * that serves the page sees it. That property is only worth something if the
 * fragment does not survive the boot: a token left in the address bar is in
 * every screenshot, every share sheet, every `document.referrer` and every
 * reload.
 *
 * ONE ORIGIN CAN HOST MANY MACHINES. On a machine's own page the origin IS
 * the machine, so a single `cookrew-pairing-token` key cannot be ambiguous,
 * and the base is ''. The console is one origin for every machine of the
 * account and therefore one localStorage, and its base is the machine's relay
 * address, `<api origin>/api/m/<machine id>` (machine-scope.ts): one key
 * would hand machine B the token minted for machine A. That is not merely a
 * 401 that reads as "randomly unpaired"; it is a credential sent to a machine
 * it was never minted for. So there the key carries the machine's id.
 *
 * Everything here is pure, because both rules are get-them-wrong-quietly rules
 * and a rule that needs a browser to test is a rule that gets tested once.
 */

import { MACHINE_RELAY_PREFIX } from '../../shared/machine-relay'

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

/**
 * `cr_token:<machine id>`: one machine, one key, under the console's one origin.
 *
 * TODO(V3-14): THE SEAM FOR THE PER-DEVICE TOKEN. The Mac half (V3-21) is in
 * place: the token stored here is about to stop being the root pairing token
 * and become this phone's own. The companion bootstraps ONCE per Mac —
 *
 *   POST <plane>/api/admit
 *     Authorization: Bearer <root token>          (or a per-device token, to re-mint)
 *     { deviceId, name?, jwk, nonce, issuedAtMs, sig }
 *       sig = Ed25519( "cookrew-admit/1 <deviceId> <origin> <issuedAtMs> <nonce>" )
 *       origin = the Mac origin this request is sent to, as the Mac published it
 *       nonce  = 16..64 random bytes, base64url; issuedAtMs within ±120 s
 *       deviceId = the key's thumbprint (account-v2.ts · deviceIdFor)
 *     → 200 { deviceId, name?, token, desktopId }
 *   Down the relay the stamp names the device and the body may be {} —
 *   the registry has already authenticated the phone.
 *
 * — and stores `token` under this key in place of the root; a 401 on any
 * other route with a root token in hand means "bootstrap, then retry". Until
 * the companion does this, the Mac keeps honouring the root everywhere
 * (companion-gate.ts · rootEverywhere).
 */
export const DESKTOP_TOKEN_PREFIX = 'cr_token:'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** A machine's relay address ends with the relay prefix and its id (shared/machine-relay.ts). */
const DESKTOP_IN_BASE = new RegExp(`${MACHINE_RELAY_PREFIX}/(${UUID})/?$`, 'i')

/**
 * The machine's id inside its relay address, or null when the base is not one
 * ('' on a machine's own page, and anything that is not `…/api/m/<id>`).
 *
 * Read from the machine's relay address (api-base.ts · clientBase), never
 * from `location.pathname`: the address is built from the machine in scope,
 * and the pathname is whatever the page has navigated to since.
 */
export const desktopIdFromBase = (base: string): string | null => {
  const match = DESKTOP_IN_BASE.exec(base)
  return match ? match[1].toLowerCase() : null
}

/**
 * Where this client's token lives.
 *
 * On a machine's own page (base ''): the root key, so nothing about an
 * existing LAN pairing changes. On the console: keyed by the machine's id.
 * And when the base is one we cannot read, keyed by the base itself: an
 * unreadable base is still not the root, and falling back to the root key
 * there would hand that machine whichever token a direct pairing left behind.
 */
export const tokenKeyForBase = (base: string): string => {
  const trimmed = base.replace(/\/+$/, '')
  if (trimmed.length === 0) return ROOT_TOKEN_KEY
  return `${DESKTOP_TOKEN_PREFIX}${desktopIdFromBase(trimmed) ?? trimmed}`
}

/** The query parameter a DIRECT pairing URL carries: `?token=`. */
export const TOKEN_PARAM = 'token'

/** The fragment parameter a pasted pairing link carries: `#pair=`. */
export const PAIR_PARAM = 'pair'

/** The sealed session's connect code, beside the token in the same fragment. */
export const CODE_PARAM = 'code'

/** 32 bytes, base64url, as main/connect-code.ts writes it. */
const CONNECT_CODE_SHAPE = /^[A-Za-z0-9_-]{43}$/

/** `cr_code:<machine id>` on the console, `cr_code` on a machine's own page: as for the token. */
export const codeKeyForBase = (base: string): string => {
  const trimmed = base.replace(/\/+$/, '')
  return trimmed.length === 0 ? 'cr_code' : `cr_code:${desktopIdFromBase(trimmed) ?? trimmed}`
}

/**
 * A CODE THAT WAITS BESIDE THE ONE HELD. A code handed in a link never replaces
 * one already held for that machine (a link somebody else made must not be able
 * to throw a good code away). It waits under this key, and is tried once if the
 * machine refuses the held one, which is what happens when the machine really
 * did mint a new code.
 */
export const nextCodeKey = (codeKey: string): string => `${codeKey}.next`

/** The code that waited, taken (it is tried once), or null. */
export function takeNextCode(storage: Pick<Storage, 'getItem' | 'removeItem'>, codeKey: string): string | null {
  try {
    const next = storage.getItem(nextCodeKey(codeKey))
    if (next !== null) storage.removeItem(nextCodeKey(codeKey))
    return next
  } catch {
    return null
  }
}

/**
 * `?from=relay` — the marker the retired OPEN ON WI-FI button wrote. Nothing
 * writes it now, but links and bookmarks made with it still arrive, so it is
 * still scrubbed off the address bar. The VALUE is checked rather than the
 * key: `from` is a generic enough name to belong to somebody else's link, and
 * silently rewriting a stranger's query string is not this module's business.
 */
export const FROM_PARAM = 'from'
export const FROM_RELAY = 'relay'

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

/** The connect code carried by a fragment, or null when there is none. */
export const connectCodeFromFragment = (hash: string): string | null => {
  if (!hash || !hash.includes(CODE_PARAM)) return null
  try {
    const found = splitHash(hash).params.get(CODE_PARAM)
    return found && CONNECT_CODE_SHAPE.test(found) ? found : null
  } catch {
    return null
  }
}

/** The same fragment with the credentials taken out, keeping whatever else it held. */
export const stripPairFragment = (hash: string): string => {
  if (!hash) return hash
  try {
    const { prefix, params } = splitHash(hash)
    if (!params.has(PAIR_PARAM) && !params.has(CODE_PARAM)) return hash
    params.delete(PAIR_PARAM)
    params.delete(CODE_PARAM)
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
 *
 * `from=relay` GOES WITH THE TOKEN, in the same pass. It is not a credential,
 * only a stale marker from a retired button; one scrub, one history entry.
 */
export const scrubPairingFromUrl = (href: string): string | null => {
  try {
    const url = new URL(href)
    const hadToken = url.searchParams.has(TOKEN_PARAM)
    const hadFrom = url.searchParams.get(FROM_PARAM) === FROM_RELAY
    const nextHash = stripPairFragment(url.hash)
    if (!hadToken && !hadFrom && nextHash === url.hash) return null
    url.searchParams.delete(TOKEN_PARAM)
    if (hadFrom) url.searchParams.delete(FROM_PARAM)
    url.hash = nextHash
    return url.toString()
  } catch {
    return null
  }
}
