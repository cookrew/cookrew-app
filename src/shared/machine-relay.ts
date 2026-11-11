/**
 * ONE RELAY PATH FOR EVERY CLIENT (0.6.0): `<api origin>/api/m/<machine id>/<route>`.
 *
 * The console page, the desktop app and the watch all reach a machine of the
 * account the same way. Two credentials ride one request, for two different
 * questions, in two different headers:
 *
 *   x-cookrew-session   the account session. The relay reads it, decides whose
 *                       machine this is, and never forwards it.
 *   authorization       the caller's own credential AT THAT MACHINE (a pairing
 *                       token, a machine key). The relay does not read it; it
 *                       crosses as it stands.
 *
 * No cookie admits anyone here, so no other site can spend a visitor's
 * session on it. The account is named by the session and by nothing in the
 * URL, so a link cannot address somebody else's machine. Only a machine's API
 * (`api/…`) and its sealed session (`~seal/…`) cross: the relay carries no page.
 */

/** The header the account session travels in on the relay path. */
export const RELAY_SESSION_HEADER = 'x-cookrew-session'

/**
 * What the relay itself answers, with a 401, when it does not take the account
 * session (registry/src/v2-canvas-relay.ts). A machine's own 401 is a sentence
 * about its token, so the two are told apart by this word: one means "sign in
 * again", the other "this machine no longer takes this browser's key".
 */
export const RELAY_UNAUTHENTICATED = 'unauthenticated'

/**
 * What the relay answers, with a 503, for a machine of the account that holds
 * no line to it just now (registry/src/v2-canvas-relay.ts): Cookrew is closed
 * on it, or it lost its network. The machine said nothing; the relay did.
 */
export const RELAY_NO_LINK = 'no_link'

/** The path prefix every relayed machine call begins with. */
export const MACHINE_RELAY_PREFIX = '/api/m'

const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A machine's id as the registry keeps it: a lowercase uuid. */
export const isMachineId = (value: unknown): value is string => typeof value === 'string' && MACHINE_ID.test(value)

/** The first segment of every route the relay carries: the machine's API, and the sealed session's own routes. */
const RELAYED_ROOTS = new Set(['api', '~seal'])

/**
 * Is this route one the relay carries: a machine's API (`api/…`) or its sealed
 * session (`~seal/…`, main/canvas-seal-terminus.ts), and nothing beside them.
 * No page, no asset.
 */
export function isRelayedRoute(route: string): boolean {
  const path = route.split('?')[0]
  // No climbing out, however it is spelled: an encoded slash, backslash or dot
  // is refused outright rather than left for a later reader to decode into one.
  if (/%2f|%5c|%2e|\\/i.test(path)) return false
  const segments = path.split('/')
  if (!RELAYED_ROOTS.has(segments[0])) return false
  return !segments.some((segment) => segment === '..' || segment === '.')
}

/**
 * The relay path of one route on one machine, or null when either half is not
 * what it may be. `route` is the machine's own path with or without its
 * leading slash (`api/fleet`, `/api/watch/cards?workspace=w1`, `/~seal/hello`).
 */
export function machineRelayPath(machineId: string, route: string): string | null {
  const id = machineId.toLowerCase()
  const bare = route.replace(/^\/+/, '')
  if (!MACHINE_ID.test(id) || !isRelayedRoute(bare)) return null
  return `${MACHINE_RELAY_PREFIX}/${id}/${bare}`
}

/**
 * ONE ADDRESS FOR EVERY RELAYED CALL A PAGE MAKES (latency 0.6.1).
 *
 * A page on the console sends the account session in a header, so its browser
 * PREFLIGHTS every relayed request, and keeps the answer per URL. Every new
 * route, and every new query on an old one (`turns?after=…`, `thumbs?known=…`),
 * was a preflight: one more round trip before the call itself, ~405 ms from
 * the owner's Mac (measured 2026-11-11: 30 preflights in 20 s inside one
 * machine on the console stage). At one address the browser asks once and the
 * answer covers the visit.
 *
 * So a page sends `<api>/api/m` and names the machine and the route in these
 * two headers. The registry unfolds them into the very path the path form
 * carries (`relayPathFromHeaders`) and checks it the same way, so nothing the
 * path form refuses gets in this way. The path form stays for clients that are
 * not browsers (the desktop app, the watch): nothing preflights them.
 */
export const RELAY_MACHINE_HEADER = 'x-cookrew-machine'
export const RELAY_ROUTE_HEADER = 'x-cookrew-route'
/** A route longer than this is not a route: the registry refuses it rather than carry it. */
export const RELAY_ROUTE_MAX = 4096

/** What a route header may be made of: printable ASCII, no blank, and no fragment. */
const ROUTE_CHARS = /^[\x21-\x22\x24-\x7e]+$/

/**
 * A relayed call to a machine at the API origin, folded into the one address
 * and its two headers; null for anything else (another origin, the registry's
 * own routes, a route the relay does not carry). The route is taken as a URL
 * holds it, percent-encoded, so a header can always carry it.
 */
export function relayAtOneAddress(url: string, apiOrigin: string): { url: string; headers: Record<string, string> } | null {
  let parsed: URL
  let api: URL
  try {
    parsed = new URL(url)
    api = new URL(apiOrigin)
  } catch {
    return null
  }
  if (parsed.origin !== api.origin) return null
  const found = /^\/api\/m\/([^/]+)\/(.+)$/.exec(parsed.pathname)
  if (found === null) return null
  const machine = found[1].toLowerCase()
  const route = `${found[2]}${parsed.search}`
  if (relayPathFromHeaders(machine, route) === null) return null
  return { url: `${api.origin}${MACHINE_RELAY_PREFIX}`, headers: { [RELAY_MACHINE_HEADER]: machine, [RELAY_ROUTE_HEADER]: route } }
}

/**
 * The registry's reading of the two headers: the relay path they name, with
 * its query, or null. The same checks as the path form (`machineRelayPath`),
 * and before them the ones only a header needs: one value each, nothing a
 * header should not hold, and a bounded length.
 */
export function relayPathFromHeaders(machine: unknown, route: unknown): string | null {
  if (typeof machine !== 'string' || typeof route !== 'string') return null
  if (route.length === 0 || route.length > RELAY_ROUTE_MAX || !ROUTE_CHARS.test(route)) return null
  return machineRelayPath(machine, route)
}
