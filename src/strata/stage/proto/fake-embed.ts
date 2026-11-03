// PROTOTYPE stand-ins for level 3's two fades (motion.html §13): a fake
// EmbedPool (Harbor's), a fake frame layer over the terminal pane, and the
// HUD as the shell's top bar (Usher's). Both fades run outside React, on the
// pool's subscribe() and the stage's stageRest, with the LEVEL3 numbers.
//   ?ready=<ms>  how long the fake embed takes to be shown after open() (default 250)
import type { Rect, StrataPath } from '../../../shared/strata'
import type { EmbedPool, EmbedState } from '../../seams'
import { LEVEL3 } from '../motion'
import { pathKey } from '../plan'
import { stageRest } from '../telemetry'

const READY_MS = Number(new URLSearchParams(location.search).get('ready') ?? 250)
const CLOSED: EmbedState = { shown: null, opening: null, failed: null }

export const createFakePool = (readyMs = READY_MS): EmbedPool => {
  let state: EmbedState = CLOSED
  let listeners: Array<() => void> = []
  let timer = 0
  const set = (next: EmbedState) => {
    state = next
    listeners.forEach((fn) => fn())
  }
  return {
    host: () => undefined,
    prewarm: () => undefined,
    prefetch: () => undefined,
    open(path) {
      window.clearTimeout(timer)
      const who = { machineId: path.machine, agentId: path.agent }
      set({ shown: null, opening: who, failed: null })
      return new Promise((resolve) => {
        timer = window.setTimeout(() => {
          performance.mark('fake-embed:shown')
          set({ shown: who, opening: null, failed: null })
          resolve()
        }, readyMs)
      })
    },
    close() {
      window.clearTimeout(timer)
      if (state.shown || state.opening) set(CLOSED)
    },
    state: () => state,
    subscribe(fn) {
      listeners = [...listeners, fn]
      return () => {
        listeners = listeners.filter((l) => l !== fn)
      }
    }
  }
}

/** Opacity from where it is now to `to`: a fade reversed mid-way does not jump. */
const fade = (el: HTMLElement, to: number, t: { ms: number; easing: string }) => {
  const from = Number(getComputedStyle(el).opacity)
  el.getAnimations().forEach((a) => a.cancel())
  el.style.opacity = String(to)
  el.animate([{ opacity: from }, { opacity: to }], { duration: t.ms, easing: t.easing })
}

/**
 * The frame layer and the top bar, wired the way Harbor's and Usher's will be:
 * the frame is in once the stage rests at the shown agent's terminal; the bar
 * is out while the frame is in. Returns a disposer.
 */
export const wireLevel3 = (pool: EmbedPool, frame: HTMLElement, bar: HTMLElement, place: () => Rect, terminalOf: (s: EmbedState) => StrataPath | null): (() => void) => {
  let frameIn = false
  const update = () => {
    const shown = terminalOf(pool.state())
    const want = !!shown && stageRest.get() === pathKey(shown)
    if (want === frameIn) return
    frameIn = want
    if (want) {
      const r = place()
      Object.assign(frame.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
    }
    if (want) frame.dataset.shown = ''
    else delete frame.dataset.shown
    fade(frame, want ? 1 : 0, want ? LEVEL3.frameIn : LEVEL3.frameOut)
    fade(bar, want ? 0 : 1, want ? LEVEL3.barOut : LEVEL3.barIn)
  }
  const offPool = pool.subscribe(update)
  const offRest = stageRest.subscribe(update)
  update()
  return () => {
    offPool()
    offRest()
  }
}
