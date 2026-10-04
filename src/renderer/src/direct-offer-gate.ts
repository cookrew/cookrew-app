import type { DirectOffer } from './path/direct-offer'

/**
 * WHETHER THE ONE NAVIGATION IS ON THE TABLE RIGHT NOW.
 *
 * The decision is pure and lives in path/direct-offer.ts; the facts it needs —
 * the base, the plane, the browser, the permission, the last race's rows, the
 * desktop's trusted names and whether there is a token — are spread across
 * five modules and a fetch, and every one of them is already in the switcher's
 * hand once a race ends. So the switcher decides, once per race, and publishes
 * the answer here.
 *
 * THE OFFER CARRIES NO CREDENTIAL, and that is the point of it being a value
 * rather than a URL. What is published is an origin and a word for a network,
 * both of which are already on the desktop's public reach card; the token is
 * read at the tap and lives for the length of one `location.assign`.
 *
 * Shaped like local-network-gate.ts, for the same reason: React reads it and a
 * race loop writes it.
 */

let offer: DirectOffer | null = null
/**
 * THE READER CLOSED THE LINE UNDER THE BADGE. Session-only and per offer: the
 * 60-second race re-publishes the same answer and must not re-raise a line
 * somebody dismissed, while a new address on a new network is news again.
 * The sheet's own row is never hidden — it is behind a tap already.
 */
let lineHidden = false
const listeners = new Set<(next: DirectOffer | null) => void>()

export const directOffer = (): DirectOffer | null => offer

export const directOfferLineHidden = (): boolean => lineHidden

export const hideDirectOfferLine = (): void => {
  if (lineHidden) return
  lineHidden = true
  for (const listener of listeners) listener(offer)
}

/**
 * Publish the answer, including "no". A race that stops qualifying must take
 * the button away — an offer left standing after the plane went direct would
 * send a working session on a page load for nothing.
 */
export const setDirectOffer = (next: DirectOffer | null): void => {
  // The reason is part of the identity: the same address offered because of a
  // system proxy carries a different sentence from the same address offered
  // because iOS has no permission to give (path/direct-offer.ts · proxy).
  if (
    offer?.origin === next?.origin &&
    offer?.kind === next?.kind &&
    offer?.family === next?.family &&
    offer?.reason === next?.reason
  ) {
    return
  }
  offer = next
  lineHidden = false
  for (const listener of listeners) listener(offer)
}

export const subscribeDirectOffer = (
  listener: (next: DirectOffer | null) => void
): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Test seam: the module is a singleton and a test needs a clean one. */
export const resetDirectOffer = (): void => {
  offer = null
  lineHidden = false
  listeners.clear()
}
