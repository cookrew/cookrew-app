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

export type LinkHealth = 'live' | 'reconnecting' | 'failed'

export interface PlaneHealthDeps {
  readonly now?: () => number
  readonly schedule?: (run: () => void, ms: number) => unknown
  readonly cancel?: (handle: unknown) => void
  /** What "the plane is direct" means; injected so a test needs no store. */
  readonly direct?: () => boolean
  readonly fallBack?: () => void
  /** The grace a dropped stream gets on the plane in use. */
  readonly graceMs?: () => number
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
  readonly condemn: () => void
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

  let failures = 0
  let holdUntil = 0
  let lastGaveAt = -Infinity
  let lastHold = 0
  let grace: unknown = null

  const clearGrace = (): void => {
    if (grace === null) return
    cancel(grace)
    grace = null
  }

  const give = (): void => {
    failures = 0
    clearGrace()
    if (!direct()) return
    const at = now()
    lastHold = at - lastGaveAt < HOLD_REPEAT_WINDOW_MS ? Math.min(lastHold * 2, HOLD_MAX_MS) : HOLD_AFTER_FALLBACK_MS
    lastGaveAt = at
    holdUntil = at + lastHold
    fallBack()
  }

  return {
    note: (ok) => {
      if (ok) {
        failures = 0
        return
      }
      if (!direct()) return
      failures += 1
      if (failures >= DIRECT_FAILURE_LIMIT) give()
    },
    link: (state) => {
      if (state === 'live') {
        clearGrace()
        return
      }
      if (!direct() || grace !== null) return
      // The window is armed once per outage, not once per retry: a stream
      // backing off through five attempts must not reset its own deadline.
      grace = schedule(() => {
        grace = null
        give()
      }, graceMs())
    },
    condemn: give,
    held: () => now() < holdUntil,
    holdEndsAt: () => holdUntil,
    reset: () => {
      failures = 0
      holdUntil = 0
      lastGaveAt = -Infinity
      lastHold = 0
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

/** Test seam: the module is a singleton and a test needs a clean one. */
export const resetPlaneHealth = (): void => {
  singleton?.reset()
  singleton = null
}
