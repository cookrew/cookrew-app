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
 * Pure on purpose: api-base.ts composes with it rather than the other way
 * round, so the composition rule below can be tested without a browser. Its
 * one import is local-network.ts, which imports nothing itself — the address
 * space a request is aimed at is a property of the plane and belongs beside
 * the credential mode, not at a call site that has to remember it.
 */

import { addressSpaceInitFor, type AddressSpace, type AddressSpaceHint } from './local-network'

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
    kind: next.kind,
    ...(next.hint ? { hint: next.hint } : {})
  }
  // The variant is part of the identity: the same origin reached with and
  // without the annotation is two different transports, and a stream that did
  // not restart on that change would keep failing the way the probe did.
  if (
    normalized.origin === plane.origin &&
    normalized.kind === plane.kind &&
    normalized.hint === plane.hint
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
 * RELAY: same origin, and the relay prefix is gated by the ACCOUNT SESSION
 * cookie — omitting credentials there would 401 every request the companion
 * makes. It is NOT annotated for the local network: cookrew.dev is a public
 * host on a public network, and claiming otherwise would ask a browser for a
 * permission over a path that never needed one.
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

export const planeRequestInit = (current: DataPlane): PlaneRequestInit =>
  current.origin === ''
    ? { credentials: 'same-origin' }
    : { mode: 'cors', credentials: 'omit', ...planeAddressSpace(current) }
