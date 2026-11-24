/**
 * THE DIRECT LINK'S OFFER, AND WHERE IT MAY CROSS THE RELAY (lane LAN step 2,
 * ruling of Relay 2026-11-19).
 *
 * The offer and the answer carry the phone's and the Mac's addresses (ICE
 * candidates). The binding (shared/rtc-bind.ts) keeps the relay out of the
 * link; it does not keep the addresses from the relay. So:
 *
 *   WITH A SEALED SESSION (cookrew-seal/2 on the code this page holds,
 *   path/seal-plane.ts) the offer goes inside it, always, the first knock
 *   included. A knock is the first thing a page asks at boot, before the
 *   quiet try has found out whether the Mac speaks sealed, and planeFetch
 *   would send that one plain. So the try is started and waited for first.
 *   Only an ANSWER counts (seal-plane.ts · sealOutcome): a try that failed,
 *   hung past `decideMs` or waits to go again leaves the question open, and
 *   the knock is skipped, never sent plain. The pin, when it lands, knocks
 *   again (companion.ts).
 *
 *   WITH NO VERIFIED V2 SESSION the offer is never sent: a page without a
 *   code, an older Mac, or an undecided or failed handshake stays on the
 *   relay. The relay can deny the direct link but cannot read candidates
 *   from this endpoint. Older consoles paired with a new desktop also stay
 *   on the relay: the desktop refuses their unsealed RTC offer.
 */
import { apiPath } from '../api-base'
import { authHeaders } from '../auth-gate'
import { heldScope } from '../machine-scope'
import { probeSettled, sealOutcome, sealedFetchFor } from './seal-plane'
import { readRtcAnswer } from './rtc-trust'
import type { RtcAnswer } from './rtc-link'

/** How long a knock waits for the Mac to say whether it speaks sealed before it skips this round. */
export const SEAL_DECIDE_MS = 4_000

export interface RtcOfferOptions {
  readonly decideMs?: number
}

/** The outcome of the last offer's seal check, for the badge's reason (path/companion.ts). */
let lastOutcome: ReturnType<typeof sealOutcome> | null = null
export const lastOfferSealOutcome = (): ReturnType<typeof sealOutcome> | null => lastOutcome

/** sealOutcome, remembered: the check is the same one the offer waits on, never an extra probe. */
const outcomeFor = (url: string): ReturnType<typeof sealOutcome> => {
  lastOutcome = sealOutcome(url)
  return lastOutcome
}

/**
 * Has the page an answer on whether this machine speaks sealed? At once when
 * it has; otherwise the try (started by sealOutcome) is waited for, up to
 * `ms`, and asked again: a try that failed is no answer.
 */
const sealDecided = async (url: string, ms: number): Promise<boolean> => {
  if (outcomeFor(url) === 'sealed') return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>((resolve) => void (timer = setTimeout(resolve, ms)))
  try {
    await Promise.race([probeSettled(url), late])
  } finally {
    clearTimeout(timer)
  }
  return outcomeFor(url) === 'sealed'
}

/** POST the offer to the machine in scope: its answer and binding, or null (no answer, or not sent this round). */
export const postRtcOffer = async (sdp: string, options: RtcOfferOptions = {}): Promise<RtcAnswer | null> => {
  const url = apiPath('/api/rtc/offer')
  lastOutcome = null
  const sameMachine = heldScope()
  if (!(await sealDecided(url, options.decideMs ?? SEAL_DECIDE_MS))) return null
  // Left while it waited: the offer was for a machine no longer in scope.
  if (!sameMachine()) return null
  // Never hand this request to the ordinary plane: if the route disappears
  // between the pin check and sending, there is no plaintext fallback.
  const pending = sealedFetchFor(url, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ sdp })
  })
  if (pending === null) return null
  const response = await pending
  if (!sameMachine()) return null
  return response.ok ? readRtcAnswer(await response.json()) : null
}
