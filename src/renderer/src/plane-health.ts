import { registerScopeState } from './machine-scope'
import { RELAY_PLANE, dataPlane, setDataPlane } from './data-plane'

/**
 * WHEN TO GIVE UP ON THE FAST PLANE.
 *
 * A direct plane is an optimisation, and an optimisation that fails silently
 * is worse than the slow path it replaced. The failure it must catch is not
 * dramatic: the phone walks out of the house, the Wi-Fi drops, the Mac sleeps.
 * The relay is still there and still works — but every request the companion
 * makes is now going to an address that no longer answers, and nothing on
 * screen says so. That is a dead app that looks alive, which is the exact
 * failure auth-gate.ts was written to end for the credential.
 *
 * TWO SIGNALS, because they fail at different speeds:
 *
 *   CONSECUTIVE REQUEST FAILURES. Only transport failures count — a fetch that
 *   threw. A 401 or a 500 is an ANSWER, and an answer means the plane is fine
 *   and something else is wrong. One failure is a Wi-Fi hiccup; a few in a row
 *   is a path that is gone.
 *
 *   THE PUSH CHANNEL. It is the one connection that is always meant to be
 *   open, so it notices a dead plane long before an idle phone makes its next
 *   request. A drop alone is not enough — EventSource reconnects for a living
 *   — so it is a drop that has not healed within a grace window.
 *
 * AND THEN A HOLD. Falling back and immediately re-racing would find the same
 * name, get the same hello (the Mac may well still answer /api/hello from the
 * network it is on) and adopt the same dead plane, forever. The hold makes the
 * fallback stick long enough to be worth something, and the loop re-races
 * after it — the phone that walks back into the house is on the LAN again
 * within a minute, without anybody tapping anything.
 *
 * BUT FIRST, ASK THE LINK. Both signals are about the requests and streams
 * riding a plane, and on the WebRTC plane the link itself can be asked: a
 * ping the Mac answers in milliseconds when it is there (path/rtc-link.ts ·
 * probe). Before 2026-10-24 a stream that went quiet (its heartbeat stuck in
 * the Mac's send queue behind a snapshot or a browser card's frames) dropped a
 * perfectly live LAN link onto the relay, the race put it back a minute
 * later, and the badge flapped LAN/RELAY all evening. Now a link that answers
 * keeps the plane — the stream reopens on it by itself — and only one that
 * does not answer is given up. A plane that keeps needing the question
 * (KEEPS_PER_WINDOW in HOLD_REPEAT_WINDOW_MS) stops being given the benefit.
 */

/** Transport failures in a row before a direct plane is abandoned. */
export const DIRECT_FAILURE_LIMIT = 3

/** How long a dropped stream has to come back before the plane is blamed. */
export const STREAM_GRACE_MS = 5_000
/**
 * The same, on the tailnet. Away from home its path is often a Tailscale
 * relay with a ~0.5 s round trip; a reconnect is a TLS handshake plus the
 * stream's own backoff (1 s, then 2 s), and one attempt that misses already
 * spends 5 s. The owner's phone fell off TAILNET exactly that way on
 * 2026-10-18 — "back on the relay after it reconnected".
 */
export const TAILNET_STREAM_GRACE_MS = 15_000

/**
 * How long the switcher stays off a plane it just fell back from — and the
 * companion races again the moment it ends (path/companion.ts), so a tailnet
 * that came back is used within seconds of the hold, not at the next minute.
 * A plane that fails again within HOLD_REPEAT_WINDOW_MS is held twice as long
 * each time, up to HOLD_MAX_MS: a path that flaps does not get to drag the
 * phone back and forth.
 */
export const HOLD_AFTER_FALLBACK_MS = 30_000
export const HOLD_REPEAT_WINDOW_MS = 5 * 60_000
export const HOLD_MAX_MS = 5 * 60_000

/** How many times a link that answered may keep the plane within HOLD_REPEAT_WINDOW_MS. */
export const KEEPS_PER_WINDOW = 3

export type LinkHealth = 'live' | 'reconnecting' | 'failed'

/**
 * Who to ask whether the plane is still there: the WebRTC link when the plane
 * is the link (path/companion.ts registers it), nobody otherwise. Null means
 * there is nobody to ask, and the evidence is acted on as it stands.
 */
type AskAlive = (reason: string) => Promise<boolean> | null
let liveProbe: AskAlive | null = null
export const setPlaneLiveProbe = (probe: AskAlive | null): void => {
  liveProbe = probe
}

export interface PlaneHealthDeps {
  readonly now?: () => number
  readonly schedule?: (run: () => void, ms: number) => unknown
  readonly cancel?: (handle: unknown) => void
  /** What "the plane is direct" means; injected so a test needs no store. */
  readonly direct?: () => boolean
  readonly fallBack?: () => void
  /** The grace a dropped stream gets on the plane in use. */
  readonly graceMs?: () => number
  /** Is the plane still there? setPlaneLiveProbe's by default. */
  readonly alive?: AskAlive
}

export interface PlaneHealth {
  /** One request finished. `ok` is false ONLY for a transport failure. */
  readonly note: (ok: boolean) => void
  /** The push channel changed state. */
  readonly link: (state: LinkHealth) => void
  /**
   * THIS PLANE IS NOT THE MAC. Fall back now, without counting.
   *
   * The two signals above are evidence that a plane STOPPED WORKING, and both
   * wait for a few of them because one is a hiccup. This is evidence that the
   * plane is the wrong machine — a re-check whose signature named another
   * origin, or a registry that no longer vouches for it (path/plane-recheck.ts)
   * — and there is nothing to wait for: every further request would carry the
   * pairing token to it. The hold comes with it, so the switcher cannot adopt
   * the same name again on the next tick.
   */
  readonly condemn: (reason?: string) => void
  /**
   * THIS PLANE MAY HAVE STOPPED WORKING — a stream that went silent, one that
   * would not open on it. Asked of the link first, as the two signals above
   * are; falls back, with the hold, only when nothing answers.
   */
  readonly suspect: (reason: string) => void
  /** Why the plane was last given up, for the report. */
  readonly lastReason: () => string | null
  /** Is the switcher holding off after a fallback? */
  readonly held: () => boolean
  /** When the current hold ends (0 when there is none), so a race can be set for it. */
  readonly holdEndsAt: () => number
  readonly reset: () => void
}

export const createPlaneHealth = (deps: PlaneHealthDeps = {}): PlaneHealth => {
  const now = deps.now ?? ((): number => Date.now())
  const schedule = deps.schedule ?? ((run, ms): unknown => setTimeout(run, ms))
  const cancel = deps.cancel ?? ((handle): void => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const direct = deps.direct ?? ((): boolean => dataPlane().kind !== 'relay')
  const fallBack = deps.fallBack ?? ((): void => setDataPlane(RELAY_PLANE))
  const graceMs =
    deps.graceMs ?? ((): number => (dataPlane().kind === 'tailnet' ? TAILNET_STREAM_GRACE_MS : STREAM_GRACE_MS))
  const alive = deps.alive ?? ((reason: string): Promise<boolean> | null => liveProbe?.(reason) ?? null)

  let failures = 0
  let holdUntil = 0
  let lastGaveAt = -Infinity
  let lastHold = 0
  let grace: unknown = null
  let asking = false
  /** Bumped by reset, so an answer to a question asked before it is ignored. */
  let era = 0
  let keeps: number[] = []
  let lastReason: string | null = null
  let stream: LinkHealth = 'live'

  const clearGrace = (): void => {
    if (grace === null) return
    cancel(grace)
    grace = null
  }

  /**
   * Fall back, with the hold. `asked`: the link was asked and did not answer,
   * and closing itself it has usually moved the plane already — the hold is
   * set all the same, or the next race would knock the same dead link open.
   */
  const fall = (reason: string, asked = false): void => {
    if (!direct() && !asked) return
    const at = now()
    lastHold = at - lastGaveAt < HOLD_REPEAT_WINDOW_MS ? Math.min(lastHold * 2, HOLD_MAX_MS) : HOLD_AFTER_FALLBACK_MS
    lastGaveAt = at
    holdUntil = at + lastHold
    lastReason = reason
    if (direct()) fallBack()
  }

  const armGrace = (): void => {
    grace = schedule(() => {
      grace = null
      give('the push stream did not come back', true)
    }, graceMs())
  }

  /** Give the plane up — after asking whoever can say it is still there, when `ask`. */
  const give = (reason: string, ask: boolean): void => {
    failures = 0
    clearGrace()
    if (!direct()) return
    if (!ask) return fall(reason)
    // The same question is already out; its answer covers this one too.
    if (asking) return
    const at = now()
    keeps = keeps.filter((kept) => at - kept < HOLD_REPEAT_WINDOW_MS)
    const question = keeps.length < KEEPS_PER_WINDOW ? alive(reason) : null
    if (!question) return fall(reason)
    asking = true
    const askedIn = era
    void question
      .catch(() => false)
      .then((answered) => {
        if (askedIn !== era) return
        asking = false
        if (!answered) return fall(reason, true)
        keeps = [...keeps, now()]
        // Kept, and the stream is still down: it gets its grace again.
        if (stream !== 'live' && grace === null && direct()) armGrace()
      })
  }

  return {
    note: (ok) => {
      if (ok) {
        failures = 0
        return
      }
      if (!direct()) return
      failures += 1
      if (failures >= DIRECT_FAILURE_LIMIT) give(`${DIRECT_FAILURE_LIMIT} requests in a row got no answer`, true)
    },
    link: (state) => {
      stream = state
      if (state === 'live') {
        clearGrace()
        return
      }
      if (!direct() || grace !== null) return
      // The window is armed once per outage, not once per retry: a stream
      // backing off through five attempts must not reset its own deadline.
      armGrace()
    },
    condemn: (reason = 'it is not the Mac') => give(reason, false),
    suspect: (reason) => give(reason, true),
    lastReason: () => lastReason,
    held: () => now() < holdUntil,
    holdEndsAt: () => holdUntil,
    reset: () => {
      failures = 0
      holdUntil = 0
      lastGaveAt = -Infinity
      lastHold = 0
      asking = false
      era += 1
      keeps = []
      lastReason = null
      stream = 'live'
      clearGrace()
    }
  }
}

let singleton: PlaneHealth | null = null

/** The app-wide health, created on first use so tests can avoid the globals. */
export const planeHealth = (): PlaneHealth => {
  if (!singleton) singleton = createPlaneHealth()
  return singleton
}

// The health of a direct plane is ONE machine's: its failures, its hold-off,
// and the question "is the link alive" put to that machine's own link. A hold
// earned by the last machine would keep the next from ever trying its own.
registerScopeState('plane health', () => {
  singleton?.reset()
  liveProbe = null
})

/** Test seam: the module is a singleton and a test needs a clean one. */
export const resetPlaneHealth = (): void => {
  singleton?.reset()
  singleton = null
}
