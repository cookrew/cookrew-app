/**
 * THE ONE URL A PHONE IS EVER GIVEN.
 *
 * Reach v2.1 collapses pairing to a single credential and a single address:
 * the pairing token this Mac already mints and persists (pairing-token.ts),
 * carried to the phone inside the relay URL that cookrew.dev serves this
 * desktop at.
 *
 *   https://cookrew.dev/relay/@drej/desktop/<deviceId>/#pair=<token>
 *
 * THE TOKEN IS IN THE FRAGMENT, and that is the whole reason this file exists
 * rather than a template literal at each call site. A fragment is never put on
 * the wire: the browser keeps it, so cookrew.dev routes the request, serves
 * the shell and never learns the credential that authorises the phone at the
 * Mac. Move it into the query "for symmetry with the LAN URLs" and the
 * registry — plus every proxy and access log between here and it — receives a
 * permanent key to somebody's desktop.
 *
 * THE PREFIX IS THE RELAY'S OWN, spelled exactly as relay-base.ts matches it,
 * so the phone stays on cookrew.dev for the life of the page and the data
 * plane moves underneath it. A pairing URL that pointed at a LAN or tailnet
 * address would be a phone sent to a network it may not be on — which is the
 * failure v2.1 exists to end.
 *
 * NO ORIGIN IS HARD-CODED HERE. The origin arrives from wherever the app
 * already reads it (COOKREW_REGISTRY, via account-v2's registryOrigin), so a
 * self-hosted registry keeps working.
 */

/** The fragment key. Read here and, on the companion, nowhere else. */
export const PAIR_FRAGMENT = 'pair'

/** A registry handle: lowercase, 1–32, no leading or trailing dash. */
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

/** The device id account-v2 derives from the device key: a lowercase UUID. */
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type RelayDesktopInput = {
  readonly registryOrigin: string
  readonly username: string
  readonly deviceId: string
}

export type PairingUrlInput = RelayDesktopInput & {
  readonly pairingToken: string
}

/**
 * The origin, trimmed of trailing slashes, or null if it is not one we would
 * send a phone to.
 *
 * https only: the fragment is the credential's only protection on the phone's
 * own screen, but the shell it loads is what will hold that credential, and a
 * shell served in the clear can be rewritten in flight by anyone on the path.
 *
 * THE ONE EXCEPTION IS LOOPBACK. A registry on 127.0.0.1 is a developer's own
 * process on this same machine; nothing is on the path to rewrite anything,
 * and refusing it would leave the real pairing flow untestable end to end.
 */
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])

const originOf = (raw: string): string | null => {
  try {
    const url = new URL(raw)
    const clear = url.protocol === 'http:' && LOOPBACK.has(url.hostname)
    if (url.protocol !== 'https:' && !clear) return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

/** Where cookrew.dev serves this desktop. No credential in it. */
export const relayDesktopUrl = (input: RelayDesktopInput): string | null => {
  const origin = originOf(input.registryOrigin)
  if (!origin) return null
  if (!USERNAME.test(input.username)) return null
  if (!DEVICE_ID.test(input.deviceId)) return null
  return `${origin}/relay/@${input.username}/desktop/${input.deviceId}/`
}

/**
 * The pairing URL: the relay address with the token in its fragment.
 *
 * Encoded rather than interpolated. The token is base64url today and a second
 * `#` or `&` in a future one would silently truncate the credential the phone
 * stores, which reads as "pairing does not work" and not as "the URL is wrong".
 */
export const pairingUrl = (input: PairingUrlInput): string | null => {
  const base = relayDesktopUrl(input)
  if (!base || input.pairingToken.length === 0) return null
  return `${base}#${PAIR_FRAGMENT}=${encodeURIComponent(input.pairingToken)}`
}

/**
 * The token out of a fragment, or null.
 *
 * The inverse belongs beside the assembly so the two cannot drift: the
 * companion reads what this writes, and a test that round-trips them is the
 * only place the pair is checked together.
 */
export const parsePairingFragment = (hash: string): string | null => {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (raw.length === 0) return null
  const found = new URLSearchParams(raw).get(PAIR_FRAGMENT)
  return found ? found : null
}
