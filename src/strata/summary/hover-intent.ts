// HOVER INTENT for the summary card: shows after the pointer settles for
// `intentMs`, survives a short trip into the card (`graceMs`), and once a card
// has shown, neighbours swap in instantly for `warmMs` (the tooltip rule).
// Timers only — no per-frame work; the owner gets one onShow/onHide per change.

export interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
  now: () => number
}

export interface HoverIntentOptions {
  intentMs?: number
  graceMs?: number
  warmMs?: number
  onShow: (key: string) => void
  onHide: () => void
  timers?: Timers
}

export interface HoverIntent {
  /** Pointer (or keyboard highlight) arrived on an item. */
  enter(key: string): void
  /** Pointer left an item. */
  leave(key: string): void
  /** Pointer entered / left the card itself. */
  holdCard(): void
  releaseCard(): void
  /** Show now (press-and-hold on touch). */
  showNow(key: string): void
  hideNow(): void
  dispose(): void
}

export const HOVER_INTENT_MS = 120
export const HOVER_GRACE_MS = 100
export const HOVER_WARM_MS = 400

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now()
}

export const createHoverIntent = (opts: HoverIntentOptions): HoverIntent => {
  const { intentMs = HOVER_INTENT_MS, graceMs = HOVER_GRACE_MS, warmMs = HOVER_WARM_MS, onShow, onHide } = opts
  const timers = opts.timers ?? realTimers
  let shown: string | null = null
  let pending: string | null = null
  let showTimer: unknown = null
  let hideTimer: unknown = null
  let hiddenAt = -Infinity

  const clearShow = () => {
    if (showTimer !== null) timers.clear(showTimer)
    showTimer = null
    pending = null
  }
  const clearHide = () => {
    if (hideTimer !== null) timers.clear(hideTimer)
    hideTimer = null
  }
  const show = (key: string) => {
    clearShow()
    clearHide()
    if (shown === key) return
    shown = key
    onShow(key)
  }
  const hide = () => {
    clearShow()
    clearHide()
    if (shown === null) return
    shown = null
    hiddenAt = timers.now()
    onHide()
  }
  const scheduleHide = () => {
    clearHide()
    hideTimer = timers.set(hide, graceMs)
  }

  return {
    enter(key) {
      clearHide()
      if (shown === key || pending === key) return
      clearShow()
      const warm = shown !== null || timers.now() - hiddenAt < warmMs
      if (warm) return show(key)
      pending = key
      showTimer = timers.set(() => show(key), intentMs)
    },
    leave(key) {
      if (pending === key) clearShow()
      if (shown !== null) scheduleHide()
    },
    holdCard: clearHide,
    releaseCard() {
      if (shown !== null) scheduleHide()
    },
    showNow: show,
    hideNow: hide,
    dispose() {
      clearShow()
      clearHide()
    }
  }
}
