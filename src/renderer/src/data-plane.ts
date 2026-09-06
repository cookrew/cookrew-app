/**
 * WHERE THIS PAGE'S REQUESTS GO, WHICH IS NOT WHERE THE PAGE CAME FROM.
 *
 * Reach v2.1's second principle is ONE URL: a phone lives at
 * `https://cookrew.dev/relay/@user/desktop/<id>/` for the life of the session,
 * and the transport underneath moves. Before this, `API_BASE` was a constant
 * read once at module load and every request went wherever the page was served
 * from — so the only way to reach the Mac faster was to NAVIGATE to it, which
 * is exactly what put the owner's phone on ERR_CERT_AUTHORITY_INVALID with the
 * pairing token in the address bar (companion-relay-no-jump.test.ts).
 *
 * So the data plane is separated from the page's base and made mutable:
 *
 *   THE PAGE'S BASE IS A FACT AND STAYS A CONSTANT. `COOKREW_BASE` and
 *   `COOKREW_SLUG` are still read once, still cannot be re-pointed by mutating
 *   a global. Nothing about which workspace this client is for is negotiable.
 *
 *   THE PLANE IS A DECISION AND IS THEREFORE A STORE. It starts on the relay —
 *   the path that is already working, because the shell arrived over it — and
 *   only ever moves to an origin that has PROVED it is this Mac
 *   (path/plane-switch.ts). A wrong value here is not a crash; it is a phone
 *   quietly talking to something that is not the Mac, which is why nothing
 *   sets it except that one verified path.
 *
 * Pure and dependency-free on purpose: api-base.ts composes with it rather
 * than the other way round, so the composition rule below can be tested
 * without a browser and there is no import cycle to reason about.
 */

/** relay = same origin under the page's base; the others are absolute origins. */
export type DataPlaneKind = 'relay' | 'lan' | 'tailnet'

export interface DataPlane {
  /** '' for the relay — same origin, under the base. Otherwise `https://host:port`. */
  readonly origin: string
  readonly kind: DataPlaneKind
}

/**
 * THE DEFAULT, AND THE ONLY SAFE ONE. The shell was served over this path, so
 * it is known to work; every other plane is a claim that has to be proved.
 */
export const RELAY_PLANE: DataPlane = { origin: '', kind: 'relay' }

let plane: DataPlane = RELAY_PLANE
const listeners = new Set<(next: DataPlane) => void>()

export const dataPlane = (): DataPlane => plane

/**
 * Move the data plane. A new object every time, never a mutation of the old
 * one — subscribers compare by identity to decide whether to reconnect a
 * socket, and a mutated plane would reconnect nothing.
 */
export const setDataPlane = (next: DataPlane): void => {
  const normalized: DataPlane = {
    origin: next.kind === 'relay' ? '' : next.origin.replace(/\/+$/, ''),
    kind: next.kind
  }
  if (normalized.origin === plane.origin && normalized.kind === plane.kind) return
  plane = normalized
  for (const listener of listeners) listener(plane)
}

/** Back to the path that carried the shell. See plane-health.ts for when. */
export const fallBackToRelay = (): void => setDataPlane(RELAY_PLANE)

export const subscribeDataPlane = (listener: (next: DataPlane) => void): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Test seam: the module is a singleton and a test needs a clean one. */
export const resetDataPlane = (): void => {
  plane = RELAY_PLANE
  listeners.clear()
}

/**
 * HOW A REQUEST URL IS COMPOSED, as one pure rule with the two planes side by
 * side so the difference cannot be misread:
 *
 *   relay   `${base}${/slug}${path}`  — root-absolute, under the relay prefix.
 *   direct  `${origin}${/slug}${path}` — absolute, and WITHOUT the base.
 *
 * The base is dropped on a direct origin because it is the RELAY's prefix: the
 * Mac serves the app at its own root, so carrying `/relay/@user/desktop/<id>/`
 * across would land every request on a 404 with no way back. The slug is kept
 * because it answers the other question — which workspace this client is for —
 * and that is true on every path.
 */
export const planePath = (
  current: DataPlane,
  base: string,
  slug: string,
  path: string
): string => {
  const scope = slug ? `/${slug}` : ''
  return current.origin === ''
    ? `${base}${scope}${path}`
    : `${current.origin}${scope}${path}`
}

/**
 * The fetch options a plane needs, which differ in the one way that matters.
 *
 * RELAY: same origin, and the relay prefix is gated by the ACCOUNT SESSION
 * cookie — omitting credentials there would 401 every request the companion
 * makes.
 *
 * DIRECT: a different origin entirely. Cookies must not travel (the Mac
 * authorises by the pairing token in an Authorization header and nothing
 * else), and the request is explicitly `cors` so a misconfigured Mac fails
 * loudly at the browser rather than being read as an empty answer.
 */
export const planeRequestInit = (current: DataPlane): Pick<RequestInit, 'mode' | 'credentials'> =>
  current.origin === ''
    ? { credentials: 'same-origin' }
    : { mode: 'cors', credentials: 'omit' }
