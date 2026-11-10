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
import type { PathReportProbe } from '../../../shared/path-report'
import type { RtcLink } from './rtc-link'

/** The attempt's row in the path report. */
export type RtcRow = PathReportProbe & { readonly kind: 'rtc'; readonly outcome: 'answered' | 'timeout' | 'closed' }

export interface RtcAdoptDeps {
  readonly connect: () => Promise<RtcLink | null>
  readonly plane: () => DataPlane
  readonly adopt: (plane: DataPlane) => void
  readonly fallBack: () => void
  readonly setLink: (link: RtcLink | null) => void
  /** The link the page holds now. Absent, an adopted link is taken to be it until it closes. */
  readonly current?: () => RtcLink | null
  readonly classify: (address: string) => 'lan' | 'tailnet' | 'other'
  /** How an adopted link ended, as a row for the next report: the evidence for a flapping badge. */
  readonly ended?: (row: RtcRow) => void
  /**
   * Is the machine this link is opened to still the one the page talks to.
   * A link takes a second or two to open, and on the console another machine
   * can be entered meanwhile: the link is then the last machine's, and adopted
   * it would carry everything meant for the next one. Absent, always.
   */
  readonly live?: () => boolean
  readonly now?: () => number
}

/** One attempt: the row for the path report, and the plane moved when it answered. */
export const adoptRtcLink = async (deps: RtcAdoptDeps): Promise<RtcRow> => {
  const now = deps.now ?? ((): number => performance.now())
  const started = now()
  const row = (outcome: RtcRow['outcome'], name: string): RtcRow => ({
    kind: 'rtc',
    name,
    outcome,
    ms: Math.round(now() - started)
  })
  const live = (): boolean => deps.live?.() !== false
  const link = await deps.connect().catch(() => null)
  if (!link) return row('timeout', 'webrtc')
  if (!live()) {
    link.close()
    return row('closed', link.via)
  }
  const network = deps.classify(link.via)
  // Whatever moved while the link was opening (a name that answered first)
  // wins: this is the way in when nothing else is.
  if (network === 'other' || deps.plane().kind !== 'relay') {
    link.close()
    return row('answered', link.via)
  }
  deps.setLink(link)
  link.onClose(() => {
    const end = link.ended()
    // How it ended is evidence for the machine it was opened to, and for no other.
    if (end && live()) {
      const rtt = end.rtt ? ` (pong ${end.rtt.p50}/${end.rtt.max} ms)` : ''
      deps.ended?.({ kind: 'rtc', name: `${link.via} closed: ${end.reason}${rtt}`, outcome: 'closed', ms: end.afterMs })
    }
    // A link the page no longer holds takes nothing with it: the one held
    // now, and the plane riding it, may be another machine's.
    if (deps.current && deps.current() !== link) return
    deps.setLink(null)
    if (deps.plane().transport === 'rtc') deps.fallBack()
  })
  deps.adopt({ origin: '', kind: network, transport: 'rtc' })
  return row('answered', link.via)
}
