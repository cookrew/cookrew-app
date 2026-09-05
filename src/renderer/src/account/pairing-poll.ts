import type { PairingKeyHandout } from '../../../shared/account-v2'

/**
 * THE POPOUT'S CLOCK, WITH NO REACT IN IT.
 *
 * This was six lines inside a `useEffect` and it was wrong in three ways at
 * once, none of which a render test could see:
 *
 *   The effect's dependency array held `now`, which defaulted to a NEW arrow
 *   on every render. Every `setHandout` re-rendered, which re-ran the effect,
 *   which cleared the one-second interval before it had ever fired. The
 *   countdown never advanced — a 120-second key sat reading "renews in 2:25"
 *   because the clock it was subtracting from was frozen at the first paint —
 *   the key never rotated, and the renderer burned ~90% of a core for as long
 *   as the sheet was open, against 0.3% with it shut.
 *
 *   It also asked main for the key once a SECOND. The key changes twice in
 *   four minutes; the other 238 requests were asking a question whose answer
 *   was on screen already.
 *
 * So the loop lives here, where a test can hold the scheduler and the clock,
 * and the component becomes a subscription. The countdown is DERIVED from
 * `expiresAt` on every tick rather than stored, so it cannot be stale.
 */

export type PairingPollState = {
  readonly handout: PairingKeyHandout | null
  /** Main has answered at least once — until then the sheet says so. */
  readonly asked: boolean
  /** The clock, advanced every tick; the countdown is computed from it. */
  readonly tick: number
}

export type PairingPollDeps = {
  readonly load: () => Promise<PairingKeyHandout | null>
  readonly now: () => number
  readonly onState: (state: PairingPollState) => void
  readonly intervalMs?: number
  readonly setInterval?: (fn: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
}

export const PAIRING_POLL_MS = 1000

export const startPairingPoll = (deps: PairingPollDeps): (() => void) => {
  const start = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const stop = deps.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout))
  let live = true
  let state: PairingPollState = { handout: null, asked: false, tick: deps.now() }

  const push = (next: Partial<PairingPollState>): void => {
    state = { ...state, ...next }
    if (live) deps.onState(state)
  }

  const pull = (): void => {
    void deps
      .load()
      .then((handout) => live && push({ handout, asked: true }))
      // A refusal is still an answer: the sheet must stop saying "reading…"
      // and fall through to the legacy shape rather than spinning forever.
      .catch(() => live && push({ asked: true }))
  }

  pull()
  const handle = start(() => {
    // A timer that fires after the sheet closed must do nothing. clearInterval
    // is not a guarantee — a tick already queued still runs — and a request
    // fired by a closed sheet is a request nobody will ever read.
    if (!live) return
    const at = deps.now()
    push({ tick: at })
    // Ask again only when the key on screen has run out. Main mints lazily,
    // so this ask is the thing that rotates it — and asking every second
    // would rotate nothing while costing a request a second.
    if (!state.handout || at >= state.handout.expiresAt) pull()
  }, deps.intervalMs ?? PAIRING_POLL_MS)

  return () => {
    live = false
    stop(handle)
  }
}
