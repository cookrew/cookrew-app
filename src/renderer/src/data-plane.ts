/**
 * WHERE THIS PAGE'S REQUESTS GO, WHICH IS NOT WHERE THE PAGE CAME FROM.
 *
 * Reach v2.1's second principle is ONE URL: the page stays at one address
 * for the life of the session (the console's, since 0.6.0), and the transport
 * underneath moves. Before this, the base of every request was a constant
 * read once at module load and every request went wherever the page was served
 * from — so the only way to reach the Mac faster was to NAVIGATE to it, which
 * is exactly what put the owner's phone on ERR_CERT_AUTHORITY_INVALID with the
 * pairing token in the address bar (companion-relay-no-jump.test.ts).
 *
 * So the data plane is separated from the machine's address and made mutable:
 *
 *   WHICH MACHINE, AND WHICH OF ITS WORKSPACES, IS A FACT (machine-scope.ts):
 *   the machine in scope and the slug the page was served for. It cannot be
 *   re-pointed by mutating a global.
 *
 *   THE PLANE IS A DECISION AND IS THEREFORE A STORE. It starts on the relay —
 *   the path that is known to work — and only ever moves to an origin that
 *   has PROVED it is this Mac
 *   (path/plane-switch.ts). A wrong value here is not a crash; it is a phone
 *   quietly talking to something that is not the Mac, which is why nothing
 *   sets it except that one verified path.
 *
 * Pure on purpose: api-base.ts composes with it rather than the other way
 * round, so the composition rule below can be tested without a browser. Its
 * one import is local-network.ts, which imports nothing itself — the address
 * space a request is aimed at is a property of the plane and belongs beside
 * the credential mode, not at a call site that has to remember it.
 */

import { addressSpaceInitFor, type AddressSpace, type AddressSpaceHint } from './local-network'
import { registerScopeState } from './machine-scope'

/** relay = same origin under the page's base; the others are absolute origins. */
export type DataPlaneKind = 'relay' | 'lan' | 'tailnet'

export interface DataPlane {
  /** '' for the relay — same origin, under the base. Otherwise `https://host:port`. */
  readonly origin: string
  readonly kind: DataPlaneKind
  /**
   * HOW THE HELLO GOT THROUGH, and therefore how everything after it must.
   *
   * Chrome 152 behind a system proxy (2026-09-08) refuses the annotated request
   * in 32 ms and delivers the unannotated one, so the probe falls back
   * (path/ask-hello.ts). A probe that fell back and a plane that went on
   * annotating would be the worst of both worlds: a hello that proved the Mac,
   * a badge saying LAN, and every request after it failing the same way.
   *
   * ABSENT MEANS "THE ADDRESS DECIDES", which is exactly what this did before
   * the fallback existed, so nothing that leaves it unset changes behaviour.
   */
  readonly hint?: AddressSpaceHint
  /**
   * THE DIRECT LINK BY WEBRTC (path/rtc-link.ts): the plane is LAN or TAILNET
   * by the Mac's own word, the origin stays '' and the relay's URLs are kept,
   * and requests and streams ride a data channel (rtc-plane.ts).
   */
  readonly transport?: 'rtc'
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
    origin: next.kind === 'relay' || next.transport === 'rtc' ? '' : next.origin.replace(/\/+$/, ''),
    kind: next.kind,
    ...(next.hint ? { hint: next.hint } : {}),
    ...(next.transport === 'rtc' && next.kind !== 'relay' ? { transport: 'rtc' as const } : {})
  }
  // The variant is part of the identity: the same origin reached with and
  // without the annotation is two different transports, and a stream that did
  // not restart on that change would keep failing the way the probe did.
  if (
    normalized.origin === plane.origin &&
    normalized.kind === plane.kind &&
    normalized.hint === plane.hint &&
    normalized.transport === plane.transport
  ) {
    return
  }
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

// A direct origin was proved to be ONE machine. Entering another starts on the
// relay again, the path that is known to work, and says so to whoever follows
// the plane (a request sent on the direct one is abandoned). It tells its
// listeners, so it goes with what stops. The listeners are the page's wiring
// and stay.
registerScopeState('data plane', () => setDataPlane(RELAY_PLANE), 'stop')

/**
 * HOW A REQUEST URL IS COMPOSED, as one pure rule with the two planes side by
 * side so the difference cannot be misread:
 *
 *   relay   `${base}${/slug}${path}`  — under the machine's relay address
 *                                      (api-base.ts: '' on a machine's own
 *                                      page, `<api origin>/api/m/<id>` on the
 *                                      console).
 *   direct  `${origin}${/slug}${path}` — absolute, and WITHOUT the base.
 *
 * The base is dropped on a direct origin because it is the RELAY's address of
 * the machine: the machine answers at its own root, so carrying
 * `/api/m/<id>` across would land every request on a 404. The slug is kept
 * because it answers the other question — which workspace this client is for —
 * and that is true on every path.
 */
/** The request options a plane composes, annotation included on a direct one. */
export type PlaneRequestInit = Pick<RequestInit, 'mode' | 'credentials'> & {
  readonly targetAddressSpace?: AddressSpace
}

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
 * The fetch options a plane needs, which differ in the ways that matter.
 *
 * RELAY: on a machine's own page it is the page's own origin, same-origin.
 * On the console it is the registry's API host, another origin with no cookie
 * (see below). It is NOT annotated for the local network: a public host on a
 * public network, and claiming otherwise would ask a browser for a permission
 * over a path that never needed one.
 *
 * DIRECT: a different origin entirely. Cookies must not travel (the Mac
 * authorises by the pairing token in an Authorization header and nothing
 * else), the request is explicitly `cors` so a misconfigured Mac fails loudly
 * at the browser rather than being read as an empty answer, and it carries
 * `targetAddressSpace: 'local'` WHEN the address it spells is in the local
 * address space. Chrome 142 blocks such a request outright without the
 * annotation, and a trusted name buys no exemption — a public hostname that
 * resolves to a private address is exactly the case Local Network Access was
 * written for. It is left OFF a CGNAT tailnet address, which no browser
 * reckons local: the annotation is an assertion the browser then checks, so
 * claiming it falsely would fail the request rather than permit it. Safe on
 * every other browser: see local-network.ts on why an unknown `RequestInit`
 * member is dropped rather than raised.
 *
 * ON EVERY REQUEST, not once. The specification requires the address-space
 * check "for each new connection made", because a name can be re-resolved
 * between two requests — which is the rebinding attack it exists to stop.
 *
 * AND THE PLANE'S OWN VARIANT OVERRULES THE ADDRESS. Chrome 152 behind a system
 * proxy (2026-09-08) refuses the annotated request to a private address in
 * 32 ms and delivers the same request without it; where the hello only got
 * through that way, so must everything after it. The address still decides
 * whenever nothing recorded a variant.
 */
const planeAddressSpace = (
  current: DataPlane
): { readonly targetAddressSpace?: AddressSpace } =>
  current.hint === 'none' ? {} : addressSpaceInitFor(current.origin)

/**
 * A request to another origin that carries no cookie: the relay from the console, and any direct path.
 *
 * AND NO `cache: 'no-store'` BESIDE IT (latency 0.6.1). Such a request carries
 * its credential in a header, so the browser preflights it, and Chrome does not
 * use its preflight cache for a request that bypasses the HTTP cache
 * ('no-store', 'no-cache', 'reload'): measured in headless Chrome 2026-11-11,
 * four calls to one URL asked four preflights with it and one without. Each is
 * a round trip, ~405 ms from the owner's Mac, on every poll for ever. Nothing
 * is lost by leaving it off: every answer of the registry and of the relay is
 * already `cache-control: private, no-store`, so the browser keeps none of them
 * (pinned in tests/api-base.test.ts).
 */
export const CROSS_ORIGIN_NO_COOKIE: Pick<RequestInit, 'mode' | 'credentials'> = { mode: 'cors', credentials: 'omit' }

export const planeRequestInit = (current: DataPlane, base = ''): PlaneRequestInit => {
  // THE RELAY, ON THE CONSOLE, IS ANOTHER ORIGIN (the registry's API host): a
  // cross-origin request that carries no cookie, because none admits anyone
  // there. The account session goes in a header (plane-fetch.ts). It is a
  // public host, so it is never annotated for the local network.
  if (current.origin === '') return isAbsolute(base) ? CROSS_ORIGIN_NO_COOKIE : { credentials: 'same-origin' }
  return { ...CROSS_ORIGIN_NO_COOKIE, ...planeAddressSpace(current) }
}

/** Is this base another origin (the console's relay address) rather than a path on this one. */
export const isAbsolute = (base: string): boolean => /^https?:\/\//i.test(base)
