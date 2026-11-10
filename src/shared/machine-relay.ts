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
