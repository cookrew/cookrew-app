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
 *   WITH NO SESSION (a page that holds no code, or a Mac that said, sealed,
 *   that it has no v2) the plain knock stays, so those consoles keep their
 *   direct link. The residual risk, stated: the relay reads both addresses
 *   and can deny the direct link (drop or spoil the answer); it cannot read
 *   anything sealed, and it cannot put itself in the link (the binding). A
 *   relay that fails every handshake of a page never pinned keeps that
 *   page's knocks from going out at all: no direct link, and no addresses.
 */
import { apiPath } from '../api-base'
import { authHeaders } from '../auth-gate'
import { planeFetch } from '../plane-fetch'
import { heldScope } from '../machine-scope'
import { probeSettled, sealOutcome } from './seal-plane'
import { readRtcAnswer } from './rtc-trust'
import type { RtcAnswer } from './rtc-link'

/** How long a knock waits for the Mac to say whether it speaks sealed before it skips this round. */
export const SEAL_DECIDE_MS = 4_000

export interface RtcOfferOptions {
  readonly decideMs?: number
}

/** Plain is allowed only where no session can exist; a sealed one goes through planeFetch sealed. */
const mayGo = (url: string): boolean => sealOutcome(url) !== 'undecided'

/**
 * Has the page an answer on whether this machine speaks sealed? At once when
 * it has; otherwise the try (started by sealOutcome) is waited for, up to
 * `ms`, and asked again: a try that failed is no answer.
 */
const sealDecided = async (url: string, ms: number): Promise<boolean> => {
  if (mayGo(url)) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>((resolve) => void (timer = setTimeout(resolve, ms)))
  try {
    await Promise.race([probeSettled(url), late])
  } finally {
    clearTimeout(timer)
  }
  return mayGo(url)
}

/** POST the offer to the machine in scope: its answer and binding, or null (no answer, or not sent this round). */
export const postRtcOffer = async (sdp: string, options: RtcOfferOptions = {}): Promise<RtcAnswer | null> => {
  const url = apiPath('/api/rtc/offer')
  const sameMachine = heldScope()
  if (!(await sealDecided(url, options.decideMs ?? SEAL_DECIDE_MS))) return null
  // Left while it waited: the offer was for a machine no longer in scope.
  if (!sameMachine()) return null
  const response = await planeFetch(url, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ sdp })
  })
  return response.ok ? readRtcAnswer(await response.json()) : null
}
