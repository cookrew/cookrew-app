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
import {
  RTC_NO_BINDING,
  RTC_NO_ED25519,
  RTC_NO_MACHINE,
  checkRtcBind,
  ed25519Available,
  type RtcBindVerdict
} from '../../../shared/rtc-bind'
import type { DirectHeld } from '../../../shared/path-badge'
import { connectRtcLink, type RtcAnswer, type RtcLink, type RtcLinkDeps } from './rtc-link'
import type { RtcUnbound } from './rtc-adopt'

/** The largest answer SDP read; the Mac's own route refuses an offer past the same size. */
export const RTC_ANSWER_MAX = 64_000

/** The gap between knocks on a Mac that did not answer, or whose link did not open. */
export const RTC_EVERY_MS = 2 * 60 * 1000
/**
 * The gap after a refused answer. Every knock hands the relay the Mac's
 * addresses (the answer's candidates); a Mac that cannot prove itself (an
 * older one, or a relay in the middle) is asked far less often for nothing.
 */
export const RTC_REFUSED_EVERY_MS = 10 * 60 * 1000

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

/** What one knock's check decided: the answer proved the Mac, was refused (and why), or neither (no answer). */
export interface KnockVerdict {
  readonly verified: boolean
  readonly refused: string | null
}

const UNDECIDED: KnockVerdict = { verified: false, refused: null }

export interface BoundKnockDeps extends RtcTrustInput {
  /** POST the offer over the current plane: the answer read off the body, or null. */
  readonly post: (offerSdp: string) => Promise<RtcAnswer | null>
  /** Test seams passed to connectRtcLink. */
  readonly link?: Pick<RtcLinkDeps, 'peer' | 'gatherMs' | 'openMs'>
}

export interface BoundKnock {
  /** Open the link, or say why the answer was refused; null when nothing answered or opened. */
  readonly connect: () => Promise<RtcLink | RtcUnbound | null>
  /** What the check decided, once connect has settled. */
  readonly verdict: () => KnockVerdict
}

/**
 * ONE KNOCK, HELD TO ONE MACHINE: connectRtcLink with the check for the
 * machine given here, and a record of what that check decided — a verified
 * answer whose link then never opens still proved the Mac. A page that could
 * never check the answer posts no offer at all.
 */
export const boundKnock = (deps: BoundKnockDeps): BoundKnock => {
  const trust = trustRtcAnswer({ machineId: deps.machineId })
  let decided: KnockVerdict = UNDECIDED
  const connect = async (): Promise<RtcLink | RtcUnbound | null> => {
    if (!(await ed25519Available())) {
      decided = { verified: false, refused: RTC_NO_ED25519 }
      return { unbound: RTC_NO_ED25519 }
    }
    const link = await connectRtcLink({
      ...deps.link,
      offer: deps.post,
      trust: async (offerSdp, answer) => {
        const verdict = await trust(offerSdp, answer)
        if (verdict.ok) decided = { verified: true, refused: null }
        return verdict
      },
      // Every refusal, the check's own or one it threw: connectRtcLink fails closed either way.
      refused: (why) => void (decided = { verified: false, refused: why })
    })
    return link ?? (decided.refused === null ? null : { unbound: decided.refused })
  }
  return { connect, verdict: () => decided }
}

/**
 * What the badge says of a refusal (shared/path-badge.ts): an older Mac, a
 * browser that cannot check, or an answer that did not prove itself. Null for
 * a page with no machine in scope, where nothing was asked of a Mac.
 */
export const heldFor = (why: string): DirectHeld | null => {
  if (why === RTC_NO_BINDING) return 'old-mac'
  if (why === RTC_NO_ED25519) return 'browser'
  if (why === RTC_NO_MACHINE) return null
  return 'unproved'
}

/**
 * The badge's reason after a knock: put down (null) once an answer proved the
 * Mac, named after a refusal, and left as it was (undefined) when nothing
 * answered, which says nothing about proof.
 */
export const heldAfter = (verdict: KnockVerdict): DirectHeld | null | undefined => {
  if (verdict.verified) return null
  return verdict.refused === null ? undefined : heldFor(verdict.refused)
}

/** How long until the next knock, after this one. */
export const knockGapAfter = (verdict: KnockVerdict): number => (verdict.refused === null ? RTC_EVERY_MS : RTC_REFUSED_EVERY_MS)
