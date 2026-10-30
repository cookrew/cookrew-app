import type { Terminal } from '@xterm/xterm'

/**
 * THE LIVE TERMINAL SCROLLS HERE, NOT IN THE PANE (owner, 2026-10-31: "live
 * is not as smooth as chat").
 *
 * herdr repaints its screen in place and keeps the history itself, so the
 * viewer's xterm only ever held one screen, and every wheel tick went to the
 * pane and waited for the repaint: 60–230 ms a tick, measured, moving in
 * jumps. Now the pane's history is laid into the viewer's own scrollback (a
 * seeded frame, main/pty.ts · buildSeededFrame) and the wheel — and the
 * phone's swipe, which arrives here as wheel events — scrolls it locally, at
 * once, like the chat.
 *
 * The seed is fetched AHEAD of any scroll (reading it costs the pane ~0.5 s):
 * when the live view opens, and again in the background while it sits at
 * the bottom and the pane's history has GROWN since (its size rides every
 * activity push; output alone is no reason — a spinner repaints all the
 * time). A scroll before the first seed lands is held and applied when it
 * does. A backend that cannot read history answers false, and the wheel goes
 * to the pane exactly as before.
 *
 * A reader scrolled up keeps their place: a seed that arrives then is
 * DROPPED (admit), which is safe — it is a full replay of a screen this
 * viewer already has, and the deltas after it apply to that screen as well.
 */

export interface LocalScrollDeps {
  /** Ask for a seeded frame ending in the marker for `nonce` (api.ptySeed). */
  seed: (nonce: string, lines: number) => Promise<boolean>
  /** Is the live view the one on screen? Hidden, it neither seeds nor scrolls. */
  live: () => boolean
  lines: number
  refreshMs: number
  /** The pane's history size, when known (activity.scrollBase). */
  history?: () => number | null
  now?: () => number
}

export interface LocalScroll {
  /** Whether to write this chunk: false for a seed while the reader is scrolled up. */
  admit(chunk: string): boolean
  /** The live view came up: seed if there is none, or it is stale. */
  onLive(): void
  dispose(): void
}

export const SEED_OSC = 777
const SEED_PREFIX = 'cookrew-seed;'
const SEED_MARK = `\x1b]${SEED_OSC};${SEED_PREFIX}`
const SEED_TIMEOUT_MS = 5000

/** Rows to move for one wheel event, carrying the remainder; pure for the tests. */
export function wheelRows(event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>, rowPx: number, rows: number, carry: number): { rows: number; carry: number } {
  const px = event.deltaMode === 1 ? event.deltaY * rowPx : event.deltaMode === 2 ? event.deltaY * rowPx * rows : event.deltaY
  const total = carry + px
  const whole = Math.trunc(total / rowPx)
  return { rows: whole, carry: total - whole * rowPx }
}

export function installLocalScroll(term: Terminal, deps: LocalScrollDeps): LocalScroll {
  const now = deps.now ?? Date.now
  let unsupported = false
  let inFlight: string | null = null
  let seeded = false
  let lastAsk = Number.NEGATIVE_INFINITY
  /** The history size the newest seed was read at; -1 = none. */
  let seededAt = -1
  let askedAt = -1
  /** Lines of history the newest seed left in the scrollback. */
  let landedBase = 0
  const history = (): number | null => deps.history?.() ?? null
  /** Behind the pane: its history grew since the seed (or no size is known and none landed). */
  const stale = (): boolean => {
    const size = history()
    // A replay (resize, reconnect) clears the scrollback: history that was
    // there and is gone is stale too.
    const wiped = landedBase > 0 && term.buffer.active.baseY === 0
    return !seeded || wiped || (size !== null && size !== seededAt)
  }
  let carry = 0
  let held = 0
  let disposed = false

  const rowPx = (): number => {
    const height = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect().height ?? 0
    return Math.max(8, height > 0 ? height / Math.max(1, term.rows) : 17)
  }
  const atBottom = (): boolean => term.buffer.active.viewportY >= term.buffer.active.baseY

  const ask = (): void => {
    // An answer that never came (sent before anything listened) expires.
    if (inFlight !== null && now() - lastAsk > SEED_TIMEOUT_MS) inFlight = null
    if (disposed || unsupported || inFlight !== null) return
    const nonce = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    inFlight = nonce
    lastAsk = now()
    askedAt = history() ?? -1
    void deps.seed(nonce, deps.lines).then(
      (ok) => {
        if (ok) return
        if (inFlight === nonce) inFlight = null
        // Never seeded and the backend said no: the pane keeps the wheel.
        if (!seeded) unsupported = true
      },
      () => {
        if (inFlight === nonce) inFlight = null
      }
    )
  }

  // The seed has been parsed: history is in the scrollback, the screen is live.
  const osc = term.parser.registerOscHandler(SEED_OSC, (data) => {
    if (!data.startsWith(SEED_PREFIX)) return false
    if (data.slice(SEED_PREFIX.length) === inFlight) inFlight = null
    seeded = true
    seededAt = askedAt
    landedBase = term.buffer.active.baseY
    if (held !== 0) {
      term.scrollLines(held)
      held = 0
    }
    return true
  })

  term.attachCustomWheelEventHandler((event) => {
    if (!deps.live() || unsupported || term.buffer.active.type !== 'normal') return true
    const step = wheelRows(event, rowPx(), term.rows, carry)
    carry = step.carry
    event.preventDefault()
    if (term.buffer.active.baseY === 0) {
      // No history here yet (first seed, or a replay wiped it): hold the
      // scroll for the seed rather than send it to the pane.
      held += step.rows
      ask()
      return false
    }
    if (step.rows !== 0) term.scrollLines(step.rows)
    return false
  })

  const timer = setInterval(() => {
    if (!deps.live() || !stale() || !atBottom() || document.visibilityState !== 'visible') return
    if (now() - lastAsk < deps.refreshMs) return
    ask()
  }, Math.max(500, Math.floor(deps.refreshMs / 2)))

  return {
    admit: (chunk) => {
      if (!chunk.includes(SEED_MARK)) return true
      if (atBottom() || term.buffer.active.baseY === 0) return true
      // Scrolled up: keep the reader's place; ask again once they are back.
      inFlight = null
      return false
    },
    onLive: () => {
      if (stale() && (atBottom() || term.buffer.active.baseY === 0)) ask()
    },
    dispose: () => {
      disposed = true
      clearInterval(timer)
      osc.dispose()
      term.attachCustomWheelEventHandler(() => true)
    }
  }
}
