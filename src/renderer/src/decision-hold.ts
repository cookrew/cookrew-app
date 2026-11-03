// THE HOLD (route program R3, fix round 1; HP round: the inversion). A
// decision shown under the box commits by itself after the hold unless the
// owner gets there first — and everything the owner does in between must be
// able to stop it:
//
//   a keystroke in the field, or opening "change"  → PAUSE (nothing commits while they choose)
//   Enter, or a click on an alternate               → COMMIT once, with that target
//   Esc, ⌘K, an inbox click, unmount                 → CLOSE: no commit, and main is told to drop the token
//
// HP: the hold TICKS by default, 2.5 s. Main may send the decision PAUSED
// (exposure ≥ 2, a respawn, a rewritten brief, a trigger that is not a box),
// or as a QUESTION / ANSWER — Sous's text with no hold at all. An exposure ≥ 2
// commit is a DISTINCT act: Enter focuses SEND ANYWAY and never commits; only
// the click commits, with `ack: 'send-anyway'`.
//
// A state machine over timers, with no React in it, so the tests own the
// clock and the box only draws `left`.

import type { Decision } from '../../main/sous-control'
import { DECISION_HOLD_MS, type DecisionMode } from '../../shared/sous-decide'

export type CommitAck = 'send-anyway'

export interface HoldDeps {
  /** Hold length and tick, in ms; the tick is what the box redraws on. Default: the decision's, else 2.5 s. */
  holdMs?: number
  tickMs?: number
  onTick: (leftMs: number) => void
  /** Called at most once, on the hold's expiry, Enter, or an alternate. */
  onCommit: (target?: string, ack?: CommitAck) => void
  /** Called when the box closes with the decision uncommitted. */
  onCancel: (token: string) => void
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

export interface Hold {
  pause: () => void
  resume: () => void
  commit: (target?: string, ack?: CommitAck) => void
  close: () => void
  readonly state: 'ticking' | 'paused' | 'committed' | 'closed'
  readonly left: number
  readonly mode: DecisionMode
}

/** How main wants this decision held; an older main sends no mode, and a question never ticks. */
export function holdMode(decision: Pick<Decision, 'kind' | 'mode'>): DecisionMode {
  if (decision.mode) return decision.mode
  return decision.kind === 'question' ? 'question' : 'ticking'
}

/** Exposure ≥ 2: the commit is a distinct act, never Enter. */
export function needsSendAnyway(decision: Pick<Decision, 'exposure'>): boolean {
  return (decision.exposure ?? 0) >= 2
}

/** What Enter does while this decision is on the line. */
export function enterAction(decision: Pick<Decision, 'kind' | 'mode' | 'exposure' | 'sentence'>, text: string): 'commit' | 'focus-send-anyway' | 'resubmit' | 'nothing' {
  const mode = holdMode(decision)
  if (mode === 'question' || mode === 'answer') return text.trim() === '' || text.trim() === decision.sentence.trim() ? 'nothing' : 'resubmit'
  if (text.trim() !== decision.sentence.trim()) return 'resubmit'
  return needsSendAnyway(decision) ? 'focus-send-anyway' : 'commit'
}

/** The badge beside the line: how it is held. */
export function modeBadge(decision: Pick<Decision, 'kind' | 'mode' | 'exposureWhy'>, state: Hold['state'], leftMs: number): string {
  const mode = holdMode(decision)
  if (mode === 'question') return 'question'
  if (mode === 'answer') return 'answer'
  if (mode === 'paused' || state === 'paused') return decision.exposureWhy ? `paused — ${decision.exposureWhy}` : 'paused · ↵ to send'
  return `auto in ${(leftMs / 1000).toFixed(1)} s · or ↵ now`
}

export function createHold(decision: Decision, deps: HoldDeps): Hold {
  const tickMs = deps.tickMs ?? 100
  const set = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis)
  const clear = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis)
  const mode = holdMode(decision)
  let left = deps.holdMs ?? decision.holdMs ?? DECISION_HOLD_MS
  let state: Hold['state'] = mode === 'ticking' ? 'ticking' : 'paused'
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
    get mode() {
      return mode
    },
    pause: () => {
      if (state !== 'ticking') return
      state = 'paused'
      stop()
    },
    resume: () => {
      // A question, an answer, or a decision main sent paused never starts ticking on its own.
      if (state !== 'paused' || mode !== 'ticking') return
      state = 'ticking'
      timer = set(tick, tickMs)
    },
    commit: (target, ack) => {
      if (state === 'committed' || state === 'closed') return
      state = 'committed'
      stop()
      deps.onCommit(target, ack)
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
