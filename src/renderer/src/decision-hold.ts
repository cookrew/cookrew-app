// THE HOLD (route program R3, fix round 1). A decision shown under the box
// commits by itself after `holdMs` unless the owner gets there first — and
// everything the owner does in between must be able to stop it:
//
//   a keystroke in the field, or opening "change"  → PAUSE (nothing commits while they choose)
//   Enter, or a click on an alternate               → COMMIT once, with that target
//   Esc, ⌘K, an inbox click, unmount                 → CLOSE: no commit, and main is told to drop the token
//
// A state machine over timers, with no React in it, so the tests own the
// clock and the box only draws `left`.

import type { Decision } from '../../main/sous-control'

export interface HoldDeps {
  /** Hold length and tick, in ms; the tick is what the box redraws on. */
  holdMs: number
  tickMs?: number
  onTick: (leftMs: number) => void
  /** Called at most once, on the hold's expiry, Enter, or an alternate. */
  onCommit: (target?: string) => void
  /** Called when the box closes with the decision uncommitted. */
  onCancel: (token: string) => void
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

export interface Hold {
  pause: () => void
  resume: () => void
  commit: (target?: string) => void
  close: () => void
  readonly state: 'ticking' | 'paused' | 'committed' | 'closed'
  readonly left: number
}

export function createHold(decision: Decision, deps: HoldDeps): Hold {
  const tickMs = deps.tickMs ?? 100
  const set = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis)
  const clear = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis)
  let left = decision.holdMs
  let state: Hold['state'] = decision.kind === 'question' ? 'paused' : 'ticking'
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null

  const stop = (): void => {
    if (timer !== null) clear(timer)
    timer = null
  }
  const tick = (): void => {
    timer = null
    if (state !== 'ticking') return
    left = Math.max(0, left - tickMs)
    deps.onTick(left)
    if (left <= 0) hold.commit()
    else timer = set(tick, tickMs)
  }
  const hold: Hold = {
    get state() {
      return state
    },
    get left() {
      return left
    },
    pause: () => {
      if (state !== 'ticking') return
      state = 'paused'
      stop()
    },
    resume: () => {
      if (state !== 'paused' || decision.kind === 'question') return
      state = 'ticking'
      timer = set(tick, tickMs)
    },
    commit: (target) => {
      if (state === 'committed' || state === 'closed') return
      state = 'committed'
      stop()
      deps.onCommit(target)
    },
    close: () => {
      if (state === 'committed' || state === 'closed') return
      state = 'closed'
      stop()
      deps.onCancel(decision.token)
    }
  }
  if (state === 'ticking') timer = set(tick, tickMs)
  return hold
}

/**
 * Enter submits — unless the keyboard is still composing (an IME candidate
 * window takes Enter to pick a character). The app's terminal has the same
 * rule in ime-input-bridge.ts; the box keeps it for a plain input.
 */
export function enterSubmits(event: { key: string; nativeEvent?: { isComposing?: boolean }; isComposing?: boolean }): boolean {
  if (event.key !== 'Enter') return false
  if (event.nativeEvent?.isComposing === true) return false
  return event.isComposing !== true
}
