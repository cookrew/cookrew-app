/**
 * FROM THE RELAY ONTO THE DIRECT LINK, AND BACK (path/rtc-link.ts).
 *
 * On the relay, open a link; when the Mac names the address it runs on, the
 * plane becomes LAN or TAILNET by that fact, with the relay's URLs kept and
 * every request and stream carried on the data channel (rtc-plane.ts). When
 * the link closes — the phone left the Wi-Fi, the Mac quit, a network
 * change — the plane falls back to the relay, which never went away.
 *
 * An address the Mac names that is neither LAN nor tailnet is not adopted:
 * the badge says what the path is, and "direct" with no network is a guess.
 *
 * Pure over its deps, so the rule is testable without a browser.
 */

import type { DataPlane } from '../data-plane'
import type { ReachProbe } from './reach-probes'
import type { RtcLink } from './rtc-link'

export interface RtcAdoptDeps {
  readonly connect: () => Promise<RtcLink | null>
  readonly plane: () => DataPlane
  readonly adopt: (plane: DataPlane) => void
  readonly fallBack: () => void
  readonly setLink: (link: RtcLink | null) => void
  readonly classify: (address: string) => 'lan' | 'tailnet' | 'other'
  readonly now?: () => number
}

/** One attempt: the row for the path report, and the plane moved when it answered. */
export const adoptRtcLink = async (deps: RtcAdoptDeps): Promise<ReachProbe> => {
  const now = deps.now ?? ((): number => performance.now())
  const started = now()
  const row = (outcome: ReachProbe['outcome'], name: string): ReachProbe => ({
    kind: 'rtc',
    name,
    outcome,
    ms: Math.round(now() - started)
  })
  const link = await deps.connect().catch(() => null)
  if (!link) return row('timeout', 'webrtc')
  const network = deps.classify(link.via)
  // Whatever moved while the link was opening (a name that answered first)
  // wins: this is the way in when nothing else is.
  if (network === 'other' || deps.plane().kind !== 'relay') {
    link.close()
    return row('answered', link.via)
  }
  deps.setLink(link)
  link.onClose(() => {
    deps.setLink(null)
    if (deps.plane().transport === 'rtc') deps.fallBack()
  })
  deps.adopt({ origin: '', kind: network, transport: 'rtc' })
  return row('answered', link.via)
}
