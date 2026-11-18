/**
 * MAY THE CONSOLE SET THE MAC'S ANSWER? (shared/rtc-bind.ts)
 *
 * The answer to POST /api/rtc/offer came over the relay, which can read and
 * rewrite it. It is set only when its binding verifies over this page's own
 * offer, signed by the account device key of the machine in scope — the one
 * the check was made for, as the knock started. Never by a connect code (a
 * crafted link can plant one). An older Mac that sends no binding, or a page
 * with no machine in scope, gets no direct link and stays on the relay.
 */
import { RTC_NO_BINDING, RTC_NO_ED25519, checkRtcBind, type RtcBindVerdict } from '../../../shared/rtc-bind'
import type { DirectHeld } from '../../../shared/path-badge'
import type { RtcAnswer } from './rtc-link'

/** The largest answer SDP read; the Mac's own route refuses an offer past the same size. */
export const RTC_ANSWER_MAX = 64_000

/** The body of POST /api/rtc/offer: the answer and whatever binding came with it, or null. */
export const readRtcAnswer = (body: unknown): RtcAnswer | null => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const { sdp, bind } = body as { sdp?: unknown; bind?: unknown }
  if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > RTC_ANSWER_MAX) return null
  return { sdp, bind }
}

export interface RtcTrustInput {
  /** The machine the link is opened to, by the registry's id; null where none is in scope. */
  readonly machineId: string | null
}

/** The check, held to one machine, as path/rtc-link.ts asks it. */
export const trustRtcAnswer =
  (input: RtcTrustInput) =>
  (offerSdp: string, answer: RtcAnswer): Promise<RtcBindVerdict> =>
    checkRtcBind({ bind: answer.bind, offerSdp, answerSdp: answer.sdp, machineId: input.machineId })

/**
 * What the badge says of a refusal (shared/path-badge.ts): an older Mac, a
 * browser that cannot check, or an answer that did not prove itself. Null for
 * a page with no machine in scope, where nothing was asked of a Mac.
 */
export const heldFor = (why: string): DirectHeld | null => {
  if (why === RTC_NO_BINDING) return 'old-mac'
  if (why === RTC_NO_ED25519) return 'browser'
  if (why === 'no machine in scope') return null
  return 'unproved'
}
