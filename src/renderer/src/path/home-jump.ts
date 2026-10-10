/**
 * COMING HOME, WITHOUT A PRESS.
 *
 * THE RULING (owner, 2026-10-11): "come home and it turns LAN by itself, no press" — and no OPEN ON
 * WI-FI button either. Until now a companion under a relay prefix never
 * navigated by itself (companion-relay-no-jump.test.ts), because the one time
 * it did it landed a phone on a self-signed certificate warning with the
 * token in the address bar. Both halves of that are gone: the name carries a
 * public certificate (reach-names.ts) and the landing scrubs the token from
 * the bar (auth-gate.ts). What remained was the fear of jumping to a Mac that
 * is not there — and that is what the probe answers.
 *
 * SO THE JUMP IS ALLOWED EXACTLY WHEN:
 *   - the page is on the relay plane under a relay prefix, and
 *   - this browser cannot move its data plane by itself (the platform offer:
 *     iOS, or Safari, with no permission to grant), and
 *   - a knock the browser DID carry reached the Mac's LAN name just now
 *     (reach-probes.ts: a socket, an image or an opaque request answered),
 *   - and this page has not jumped in the last few minutes — a landing that
 *     failed must not become a loop between the two origins.
 *
 * A pure decision over a snapshot; the caller does the navigating.
 */

import type { DirectOffer } from './direct-offer'
import type { ReachProbe } from './reach-probes'

/** A failed landing sends the reader back here; do not send them again at once. */
export const HOME_JUMP_COOLDOWN_MS = 10 * 60 * 1000

export interface HomeJumpState {
  readonly offer: DirectOffer | null
  readonly probes: readonly ReachProbe[]
  readonly lastJumpAt: number | null
  readonly now: number
}

/** The origin to navigate to, or null. */
export const homeJump = (state: HomeJumpState): string | null => {
  const offer = state.offer
  if (!offer) return null
  // A proxy is a desktop problem with a desktop answer; the platform case is
  // the one with nothing else.
  if (offer.reason === 'proxy') return null
  const name = hostOf(offer.origin)
  const reached = state.probes.some(
    (probe) => probe.outcome === 'answered' && probe.name === name
  )
  if (!reached) return null
  if (state.lastJumpAt !== null && state.now - state.lastJumpAt < HOME_JUMP_COOLDOWN_MS) return null
  return offer.origin
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}
