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

/** How long the switcher stays off a plane it just fell back from. */
export const HOLD_AFTER_FALLBACK_MS = 60_000

export type LinkHealth = 'live' | 'reconnecting' | 'failed'

export interface PlaneHealthDeps {
  readonly now?: () => number
  readonly schedule?: (run: () => void, ms: number) => unknown
  readonly cancel?: (handle: unknown) => void
  /** What "the plane is direct" means; injected so a test needs no store. */
  readonly direct?: () => boolean
  readonly fallBack?: () => void
}

export interface PlaneHealth {
  /** One request finished. `ok` is false ONLY for a transport failure. */
  readonly note: (ok: boolean) => void
  /** The push channel changed state. */
  readonly link: (state: LinkHealth) => void
  /** Is the switcher holding off after a fallback? */
  readonly held: () => boolean
  readonly reset: () => void
}

export const createPlaneHealth = (deps: PlaneHealthDeps = {}): PlaneHealth => {
  const now = deps.now ?? ((): number => Date.now())
  const schedule = deps.schedule ?? ((run, ms): unknown => setTimeout(run, ms))
  const cancel = deps.cancel ?? ((handle): void => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const direct = deps.direct ?? ((): boolean => dataPlane().kind !== 'relay')
  const fallBack = deps.fallBack ?? ((): void => setDataPlane(RELAY_PLANE))

  let failures = 0
  let holdUntil = 0
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
    holdUntil = now() + HOLD_AFTER_FALLBACK_MS
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
      }, STREAM_GRACE_MS)
    },
    held: () => now() < holdUntil,
    reset: () => {
      failures = 0
      holdUntil = 0
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
