import { heldScope, machineScope, registerScopeState } from '../machine-scope'
import { apiPath, clientBase } from '../api-base'
import { cookrew, isRemoteMode } from '../api'
import { authHeaders } from '../auth-gate'
import { PATH_REPORT_ROUTE } from '../../../shared/path-report'
import { currentBrowser } from '../browser-family'
import { createPathReporter, postPathReport } from './report'
import { adoptRtcLink, type RtcRow } from './rtc-adopt'
import { RTC_EVERY_MS, boundKnock, heldAfter, knockGapAfter, readRtcAnswer } from './rtc-trust'
import { heldRtcLink, rtcLink, setRtcLink } from '../rtc-plane'
import { isLanHostname, isTailnetHostname } from '../../../shared/path-badge'
import { pageContext } from './page-context'
import type { PathReport } from '../../../shared/path-report'
import { dataPlane, fallBackToRelay, setDataPlane, subscribeDataPlane } from '../data-plane'
import { localNetworkState } from '../local-network'
import { localNetworkGate, setLocalNetwork } from '../local-network-gate'
import { planeFetch } from '../plane-fetch'
import { HOLD_REPEAT_WINDOW_MS, KEEPS_PER_WINDOW, planeHealth, setPlaneLiveProbe, type LinkHealth } from '../plane-health'
import { followDataPlane } from '../plane-streams'
import { onStreamDeath } from '../stream-watch'
import { forgetLatency, setDirectHeld, subscribePathLink } from '../path-link'
import { startRaceLoop } from './race-loop'
import { browserConnection, leaveDirectPlane, onCellular, watchNetworkMoves } from './radio'

/**
 * THE NEARER PATH, PLUGGED INTO A REAL PHONE.
 *
 * A companion under the relay base (the console, and the phone page, which is
 * the same bundle) reaches its Mac two ways and no others: over the relay,
 * which is how the page arrived, and over the WebRTC link it knocks open by
 * itself (path/rtc-adopt.ts). The page never leaves cookrew.dev; the DATA
 * PLANE moves onto the link and back, and the badge is the only thing that
 * changes on screen.
 *
 * NO NAMES (2026-11-16). The Mac's per-machine names under d.cookrew.dev, the
 * race that probed them, the registry's zone and verify routes that vouched
 * for them, and the navigating switch a root-served page ran onto a bare LAN
 * address are all gone. A page a Mac serves itself is already on the Mac and
 * stays where it is.
 *
 * IT DOES NOTHING ON THE DESKTOP, and nothing on a page the Mac serves itself.
 */

/** The word the badge, the store and the report all use for where this ended up. */
const settledPlane = (): 'LAN' | 'TAILNET' | 'RELAY' => {
  const kind = dataPlane().kind
  return kind === 'lan' ? 'LAN' : kind === 'tailnet' ? 'TAILNET' : 'RELAY'
}

/**
 * READ THE LOCAL-NETWORK PERMISSION, AND TELL THE REST OF THE APP.
 *
 * One local read per race, no request: the report carries it to the Mac, and
 * the row under the badge says so when the browser refused it.
 */
const readLocalNetwork = async (): Promise<void> => {
  setLocalNetwork(await localNetworkState().catch(() => 'unsupported' as const))
}

/**
 * ONE REPORT PER RACE, TO THE MAC, OVER WHATEVER PLANE IS WORKING.
 *
 * Built once at start rather than per race, because the one-at-a-time guards
 * live inside it (path/report.ts) and a reporter rebuilt every minute would
 * have nothing to remember. `apiPath` scopes it to this workspace session and
 * points it at the current plane — relay or link — like every other request
 * the companion makes; there is no second transport for diagnostics.
 */
const pathReporter = (): ReturnType<typeof createPathReporter> =>
  createPathReporter({
    post: (report) =>
      postPathReport(report, {
        url: apiPath(PATH_REPORT_ROUTE),
        headers: authHeaders(),
        fetch: planeFetch
      })
  })
let tellTheDesktop = pathReporter()

/** After a link ends, the race that knocks it open again waits this long (the plane moves first). */
const RACE_AFTER_END_MS = 300
let lastRtcAt = 0
/**
 * One WebRTC attempt per this long at most: each one opens a peer on the Mac
 * (RTC_EVERY_MS), and longer after a refused answer (path/rtc-trust.ts).
 */
let rtcGapMs = RTC_EVERY_MS
/** How the last adopted link ended, carried by the next report and then dropped. */
let lastEnd: RtcRow | null = null
/** When an ended link let the next knock skip the gap, within HOLD_REPEAT_WINDOW_MS. */
let quickKnocks: readonly number[] = []

// All of the above is ONE machine's: the last report sent to it (and so what
// the next one may leave out), and when it was last knocked on. Kept across a
// change of machine, the last knock would hold the next machine's direct link
// back for two minutes it never earned.
registerScopeState('path switch memory', () => {
  tellTheDesktop = pathReporter()
  lastRtcAt = 0
  rtcGapMs = RTC_EVERY_MS
  lastEnd = null
  quickKnocks = []
})

/**
 * THE DIRECT LINK BY WEBRTC (path/rtc-adopt.ts), tried on the relay only and
 * at most every two minutes after one that did not open. When it opens, the
 * plane is LAN or TAILNET by the Mac's word and the data moves onto it; its
 * row rides the path report. `onEnd` hears when an adopted link ends.
 */
const rtcKnock = async (onEnd: () => void, live: () => boolean): Promise<RtcRow[]> => {
  if (typeof RTCPeerConnection !== 'function' || dataPlane().kind !== 'relay') return []
  const at = Date.now()
  if (at - lastRtcAt < rtcGapMs) return []
  lastRtcAt = at
  // THE ANSWER CROSSES THE RELAY: it is set only when the Mac's device
  // signature verifies over this page's offer (path/rtc-trust.ts), for the
  // machine in scope AS THIS KNOCK STARTS. One that does not is no link, and a row.
  const knock = boundKnock({
    machineId: machineScope().machineId,
    post: async (sdp) => {
      const response = await planeFetch(apiPath('/api/rtc/offer'), {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ sdp })
      })
      return response.ok ? readRtcAnswer(await response.json()) : null
    }
  })
  const probe = await adoptRtcLink({
    connect: knock.connect,
    live,
    current: heldRtcLink,
    plane: dataPlane,
    adopt: setDataPlane,
    fallBack: fallBackToRelay,
    setLink: setRtcLink,
    // A link that ended, however it ended (the Mac restarted, the Wi-Fi
    // blinked, the watchdog gave it up), is knocked open again at once rather
    // than after the two-minute gap: the gap is for a Mac that never answered,
    // not for one that just did. Before 2026-10-24 only a link that closed
    // itself got this; one the watchdog let go waited the full gap on RELAY.
    // A link that keeps ending gets the gap back after KEEPS_PER_WINDOW.
    ended: (row) => {
      lastEnd = row
      const at = Date.now()
      quickKnocks = quickKnocks.filter((knocked) => at - knocked < HOLD_REPEAT_WINDOW_MS)
      if (quickKnocks.length < KEEPS_PER_WINDOW) {
        quickKnocks = [...quickKnocks, at]
        lastRtcAt = 0
      }
      onEnd()
    },
    classify: (address) => (isTailnetHostname(address) ? 'tailnet' : isLanHostname(address) ? 'lan' : 'other')
  }).catch(() => null)
  // Only for the machine this knock was for: the badge's reason for the relay
  // (path-link.ts), and how long until the next knock.
  if (live()) {
    const held = heldAfter(knock.verdict())
    if (held !== undefined) setDirectHeld(held)
    rtcGapMs = knockGapAfter(knock.verdict())
  }
  return probe ? [probe] : []
}

/** The race's report to the Mac, with the WebRTC attempt's row when one ran. */
const reportRace = async (report: PathReport, rtc: readonly RtcRow[]): Promise<void> => {
  const ended = lastEnd ? [lastEnd] : []
  lastEnd = null
  const probes = [...ended, ...rtc]
  // The plane AFTER the attempt: a link that opened makes this LAN, and a
  // report that still said RELAY would read as a link that never came up.
  await tellTheDesktop(probes.length > 0 ? { ...report, plane: settledPlane(), probes } : report)
}

/** What a race reports: the WebRTC rows, and nothing when there are none. */
const reportLinkRows = (rtc: readonly RtcRow[]): void => {
  if (rtc.length === 0 && !lastEnd) return
  void reportRace(
    {
      at: Date.now(),
      plane: settledPlane(),
      permission: localNetworkGate(),
      browser: currentBrowser(),
      attempts: [],
      context: pageContext()
    },
    rtc
  )
}

/** window, as the watchers here need it. */
const listen = (event: string, listener: () => void): (() => void) => {
  window.addEventListener(event, listener)
  return () => window.removeEventListener(event, listener)
}

const startPlaneSwitch = (): (() => void) => {
  const health = planeHealth()
  // Set by the loop at start; the ONE-AT-A-TIME guard stays the loop's, so a
  // push from the Mac cannot start a second race beside the timer's.
  let raceNow: () => void = () => undefined
  // A link that ended while the page is in front is knocked open again within
  // a second, not at the next minute's race.
  // One asked for while a race is running is run when it is done; the loop
  // would drop it (one at a time).
  let soon: ReturnType<typeof setTimeout> | null = null
  let racing = false
  let again = false
  let stopped = false
  // THIS SWITCHER IS FOR ONE MACHINE, the one in scope when it started. A race
  // waits on the network for seconds; one that comes back after the switcher
  // was stopped, or after another machine was entered, has learned something
  // about a machine the page no longer talks to. It adopts nothing, reports
  // nothing and remembers nothing.
  const sameMachine = heldScope()
  const live = (): boolean => !stopped && sameMachine()
  const raceSoon = (): void => {
    if (stopped || document.visibilityState !== 'visible' || soon !== null) return
    soon = setTimeout(() => {
      soon = null
      if (racing) again = true
      else raceNow()
    }, RACE_AFTER_END_MS)
  }
  // The watchdog asks the link before it gives up the plane (plane-health.ts).
  setPlaneLiveProbe((reason) => (dataPlane().transport === 'rtc' ? (rtcLink()?.probe(reason) ?? null) : null))
  // The link store announces on EVERY change it holds — latency, the
  // desktop's name — and only the transport's own state is evidence about the
  // plane. Without this the latency recorded by each successful request would
  // read as "the channel is live" and quietly disarm the watchdog that is
  // waiting to see whether a dropped stream comes back.
  let lastLink: LinkHealth | null = null
  /** One race: the link, and a report of how it went. */
  const racePlane = async (): Promise<void> => {
    // Asked for by something that outlived the switcher: there is no race to
    // run, and none to charge the next machine's two-minute knock for.
    if (!live()) return
    // THE LINK FIRST: it opens in about a second where it opens at all.
    // A hold means the plane just failed; the race after the hold knocks.
    // ON A RADIO THERE IS NO LAN TO KNOCK ON (path/radio.ts): the Mac's
    // candidates are its LAN addresses, and a knock from 5G spent ~10 s of
    // gathering and waiting to learn it. WebRTC over the tailnet never opened
    // from a phone (cookrew-webrtc-lan).
    const knocked = health.held() || onCellular() ? [] : await rtcKnock(raceSoon, live)
    if (!live()) return
    // A local read and no request; the report below carries it to the Mac.
    await readLocalNetwork()
    if (!live()) return
    // The link's rows reach the Mac; a race that tried nothing reports nothing.
    reportLinkRows(knocked)
  }

  const offs: (() => void)[] = [
    () => setPlaneLiveProbe(null),
    () => {
      stopped = true
      if (soon !== null) clearTimeout(soon)
    },
    followDataPlane(),
    // The badge's latency is a measurement of the path it was taken on, and
    // the smoothing that keeps it steady within a path makes it a lie across
    // one. So a switch drops it and the next request re-establishes it.
    subscribeDataPlane(forgetLatency),
    // A STREAM THAT WENT SILENT ON A DIRECT PLANE is the path dying under it
    // (Tailscale down, the Wi-Fi gone), or the stream stuck behind bulk on a
    // link that is fine. The link is asked, which takes a ping, and the plane
    // given up only when it does not answer — no grace on top of the silence.
    // A stream that never opened is one failed connect; a phone that slept
    // blames nothing (stream-watch.ts).
    onStreamDeath((why) => {
      if (dataPlane().kind === 'relay') return
      if (why === 'silent') health.suspect('a stream went silent')
      else if (why === 'never-opened') health.note(false)
    }),
    // AND RACE AGAIN THE MOMENT A HOLD ENDS. The loop ticks once a minute, so
    // a link that came back waited up to a minute past its hold.
    (() => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const off = subscribeDataPlane((next) => {
        if (timer !== null) clearTimeout(timer)
        timer = null
        if (next.kind !== 'relay' || !health.held()) return
        timer = setTimeout(() => {
          timer = null
          raceNow()
        }, Math.max(0, health.holdEndsAt() - Date.now()) + 250)
      })
      return () => {
        off()
        if (timer !== null) clearTimeout(timer)
      }
    })(),
    // A plane that is no longer the link (the health watchdog fell back) lets
    // the link go, so the Mac's peer is freed.
    // Its end row says why: the watchdog's reason when it gave the plane up.
    subscribeDataPlane((next) => {
      if (next.transport !== 'rtc') rtcLink()?.close((health.held() ? health.lastReason() : null) ?? 'the plane moved')
    }),
    () => rtcLink()?.close('the page left'),
    // Back to the front: a link that died while the phone slept is found in
    // seconds (path/rtc-link.ts · check), not when the heartbeat gets to it.
    listen('visibilitychange', () => {
      if (document.visibilityState === 'visible') rtcLink()?.check()
    }),
    // The push channel is the first thing to notice a plane that has died, so
    // its state is fed to the health watchdog rather than only to the badge.
    subscribePathLink((state) => {
      if (state.link === lastLink) return
      lastLink = state.link
      health.link(state.link)
    }),
    // THE PHONE MOVED NETWORKS (Wi-Fi to 5G fires no `online`): a direct
    // plane proved on the last network is let go now, not when the heartbeat
    // notices 5-15 s later, and the race after it finds what this one offers
    // (path/radio.ts). Reads caught by the move go again on the relay
    // (plane-fetch.ts), so the views keep their numbers.
    watchNetworkMoves(
      () => {
        if (!live()) return
        // A new network is owed a knock now, not two minutes after the last one.
        lastRtcAt = 0
        leaveDirectPlane({ plane: dataPlane, link: heldRtcLink, fallBack: fallBackToRelay }, 'the network changed')
        raceSoon()
      },
      { connection: browserConnection(), on: listen }
    ),
    // THE MAC SAID ITS ADDRESSES MOVED (it woke on another Wi-Fi). Its link
    // candidates are new, so the knock is owed now rather than after the gap.
    cookrew().onReachChanged?.(() => {
      if (!live()) return
      lastRtcAt = 0
      raceNow()
    }) ?? ((): void => undefined),
    startRaceLoop({
      ready: (run) => void (raceNow = run),
      race: async () => {
        racing = true
        try {
          await racePlane()
        } finally {
          racing = false
          if (again) {
            again = false
            raceSoon()
          }
        }
      }
    })
  ]
  return () => offs.forEach((off) => off())
}

/**
 * Start looking for a nearer path, or answer with a no-op teardown.
 *
 * Called once at boot. The guards are here rather than at the call site so
 * main.tsx does not have to know what a path is. Only a page under the relay
 * base looks: a page the Mac serves itself is already talking to the Mac, and
 * it stays where it is — nothing here ever navigates.
 */
export const startCompanionPathSwitch = (): (() => void) => {
  if (!isRemoteMode() || clientBase() === '') return (): void => undefined
  return startPlaneSwitch()
}
