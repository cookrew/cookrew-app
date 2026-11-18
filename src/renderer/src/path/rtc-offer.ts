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
 *   would send that one plain. So the try is started and waited for first;
 *   if it has not answered within `decideMs` the knock is skipped (the next
 *   race asks again), never sent plain.
 *
 *   WITH NO SESSION (a page that holds no code, or a Mac that does not speak
 *   v2) the plain knock stays, so those consoles keep their direct link. The
 *   residual risk, stated: the relay reads both addresses and can deny the
 *   direct link (drop or spoil the answer); it cannot read anything sealed,
 *   and it cannot put itself in the link (the binding).
 */
import { apiPath } from '../api-base'
import { authHeaders } from '../auth-gate'
import { planeFetch } from '../plane-fetch'
import { probeSettled, viaSeal } from './seal-plane'
import { readRtcAnswer } from './rtc-trust'
import type { RtcAnswer } from './rtc-link'

/** How long a knock waits for the Mac to say whether it speaks sealed before it skips this round. */
export const SEAL_DECIDE_MS = 4_000

export interface RtcOfferOptions {
  readonly decideMs?: number
}

/**
 * Has the page found out whether this machine speaks sealed? True at once
 * for a pinned machine (planeFetch seals the request) and for one this page
 * holds no code for (no session can exist); otherwise the try is started and
 * waited for, and false when it does not answer in time.
 */
const sealDecided = async (url: string, ms: number): Promise<boolean> => {
  // viaSeal both answers "pinned" and, for a code not yet pinned, starts the try.
  if (viaSeal(url) !== null) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<false>((resolve) => void (timer = setTimeout(() => resolve(false), ms)))
  try {
    return await Promise.race([probeSettled(url).then(() => true as const), late])
  } finally {
    clearTimeout(timer)
  }
}

/** POST the offer to the machine in scope: its answer and binding, or null (no answer, or not sent this round). */
export const postRtcOffer = async (sdp: string, options: RtcOfferOptions = {}): Promise<RtcAnswer | null> => {
  const url = apiPath('/api/rtc/offer')
  if (!(await sealDecided(url, options.decideMs ?? SEAL_DECIDE_MS))) return null
  const response = await planeFetch(url, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ sdp })
  })
  return response.ok ? readRtcAnswer(await response.json()) : null
}
