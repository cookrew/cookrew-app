/**
 * BACK ON THE PHONE (task "Face inputs & follow-up", 2026-11-04; design
 * docs/avatar-send-design-2026-11-04.html, "Esc · Android back"): the first
 * back closes the who-picker or folds a box open for nobody, and only the next
 * steps out of the zoom, so back never leaves the view while you are typing.
 * Android's back and the companion browser's back are both a history
 * traversal, so the page keeps ONE entry of its own on top while anything
 * wants a back: pushed when that starts (the box opening), popped when it
 * ends (a fold by Esc or a press), and taken again after a back while more is
 * left. It never stacks a second entry and never leaves one behind.
 *
 * The entry is marked in history.state, so a reload while it is on top takes
 * it back as its own. A pop the guard asked for itself (history.back() is
 * async) is waited out before it touches the history again: two pops in a row
 * would leave the page.
 */

const MARK = 'cookrewBack'

export interface HistoryLike {
  readonly state: unknown
  pushState: (data: unknown, unused: string) => void
  back: () => void
}

export interface BackLayers {
  /** Something would take a back now: the picker, a box that can fold, a zoom stop above the outermost. */
  wants: () => boolean
  /** Take one back, in the Esc order (prompt-fold.ts · takeBack). */
  back: () => void
}

export interface BackGuard {
  /** Bring the history in line with `wants()`: call it whenever a layer may have changed. */
  sync: () => void
  stop: () => void
}

const markOf = (state: unknown): number => {
  const mark = state && typeof state === 'object' ? (state as Record<string, unknown>)[MARK] : undefined
  return typeof mark === 'number' ? mark : 0
}

export function listenBack(win: EventTarget, history: HistoryLike, layers: BackLayers): BackGuard {
  /** Our own pop is on its way: leave the history alone until it lands. */
  let popping = false
  /** The mark of the entry the page stands on, to tell a back from a forward. */
  let seen = markOf(history.state)
  let next = seen
  let live = true

  const sync = (): void => {
    if (!live || popping) return
    const wants = layers.wants()
    const ours = markOf(history.state) > 0
    if (wants && !ours) {
      next += 1
      const base = history.state && typeof history.state === 'object' ? history.state : {}
      history.pushState({ ...base, [MARK]: next }, '')
      seen = next
    } else if (!wants && ours) {
      popping = true
      history.back()
    }
  }

  const onPop = (): void => {
    const landed = markOf(history.state)
    const forward = landed > seen
    seen = landed
    if (popping) {
      popping = false
      return sync()
    }
    // A back from our entry: take one step, then keep an entry if more is left.
    if (!forward && layers.wants()) layers.back()
    sync()
  }

  win.addEventListener('popstate', onPop)
  return {
    sync,
    stop: () => {
      live = false
      win.removeEventListener('popstate', onPop)
    }
  }
}

/**
 * ONE GUARD PER WINDOW, held by whoever has back to take (the zoom view).
 * The view mounts and unmounts (StrictMode does it twice at once); the guard
 * stays, its layers swapped in and out, so its own pop on an unmount is never
 * read as the owner's back by the mount that follows. Released for good, its
 * entry goes with it.
 */
export interface BackHolder {
  /** Hold the guard with these layers; returns the release. */
  hold: (layers: BackLayers) => () => void
  sync: () => void
}

const holders = new WeakMap<EventTarget, BackHolder>()

export function backHolder(win: EventTarget, history: HistoryLike): BackHolder {
  const known = holders.get(win)
  if (known) return known
  let held: BackLayers | null = null
  const guard = listenBack(win, history, {
    wants: () => held?.wants() ?? false,
    back: () => held?.back()
  })
  const holder: BackHolder = {
    hold(layers) {
      held = layers
      guard.sync()
      return () => {
        if (held !== layers) return
        held = null
        guard.sync()
      }
    },
    sync: guard.sync
  }
  holders.set(win, holder)
  return holder
}
