import { EASE, still } from './prompt/face-flip'

/**
 * THE KEYBOARD, EXPECTED (owner, 2026-11-04: the box's motion was all but cut
 * off by the keyboard). A phone tells the page about its keyboard only once it
 * has landed (visualViewport, keyboard-inset.ts), so whatever moves at the
 * focus moves at the foot of the screen, behind the keyboard rising over it,
 * and the box then jumps up in one step. So the cover is expected: at the
 * focus the last one seen is published at once, and the box is already on its
 * way up, ahead of the keyboard.
 *
 * The real keyboard takes over once it settles, a small difference gliding. If
 * none comes (a hardware keyboard, a focus the page was refused) the box
 * glides back, and the next focus expects none until a keyboard is seen.
 *
 * THE BAND behind the keyboard (styles.css · .cr-app::after, --kb-band) paints
 * over the stage and the dock, so it follows the keyboard itself, not the
 * cover: none until an expected one has settled (the box rises through there,
 * and a browser may report the keyboard as it starts), and gone the moment the keyboard starts leaving (the face lands there).
 */

/** Long enough for a slow keyboard's first showing. */
export const NO_KEYBOARD_MS = 900
/** A keyboard that reports on its way up has landed when it stops reporting. */
export const SETTLE_MS = 160
/** The first time: about what a phone's keyboard takes, its word row included. */
const FIRST_GUESS = 0.4

export function coverGuess(remembered: number | null, viewHeight: number): number {
  return remembered ?? Math.round(viewHeight * FIRST_GUESS)
}

/** While it is expected, the box never comes down to a keyboard still on its way up. */
export function shownCover(truth: number, expected: number | null): number {
  return expected === null ? truth : Math.max(truth, expected)
}

export interface KeyboardEnv {
  /** The cover to show; `glideFrom` is the one it replaces when a correction should glide, else null. */
  publish(cover: number, glideFrom: number | null): void
  /** The band's height. */
  band(px: number): void
  recall(): number | null
  remember(cover: number): void
  viewHeight(): number
  /** A screen a keyboard rises on. */
  touch(): boolean
}

export interface KeyboardWatch {
  /** The visual viewport's cover, as reported. */
  report(cover: number): void
  /** A field takes the focus: how far the box rises for the keyboard coming (0: none expected). */
  expect(): number
  /** The field was let go: the keyboard, up or on its way, is going, ahead of any report. */
  leaving(): void
  dispose(): void
}

export function keyboardWatch(env: KeyboardEnv): KeyboardWatch {
  let truth = 0
  let expected: number | null = null
  let shown = -1
  let going = false
  let band = -1
  let timer: ReturnType<typeof setTimeout> | null = null
  const show = (glide: boolean): void => {
    const next = shownCover(truth, expected)
    if (next === shown) return
    const from = shown
    shown = next
    env.publish(next, glide && from >= 0 ? from : null)
  }
  const showBand = (): void => {
    const next = going || expected !== null ? 0 : truth
    if (next === band) return
    band = next
    env.band(next)
  }
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  /** Over: what shows is what the viewport says. */
  const end = (): void => {
    clear()
    expected = null
    show(true)
    showBand()
  }
  return {
    report(cover) {
      if (cover === truth && shown !== -1) return
      truth = cover
      if (cover === 0) going = false
      showBand()
      clear()
      if (cover === 0 && expected !== null) return end()
      show(false)
      if (cover === 0) return
      timer = setTimeout(() => {
        end()
        env.remember(truth)
      }, SETTLE_MS)
    },
    expect() {
      going = false
      showBand()
      if (expected !== null || truth > 0 || !env.touch()) return 0
      const guess = coverGuess(env.recall(), env.viewHeight())
      if (guess <= 0) return 0
      expected = guess
      show(false)
      timer = setTimeout(() => {
        end()
        env.remember(0)
      }, NO_KEYBOARD_MS)
      return guess
    },
    leaving() {
      going = true
      showBand()
      if (expected !== null) end()
    },
    dispose: clear
  }
}

const CORRECT_MS = 160

/**
 * The cover changed by `by` px in one step: drawn from where it was, the box
 * glides there. The box, never the dock: a transform on the dock would make it
 * the frame of the fixed copies a fold flies in it (fold-flight.ts).
 */
export function glideBox(box: Element | null, by: number): void {
  if (!box || Math.abs(by) < 2 || typeof box.animate !== 'function' || still()) return
  box.animate([{ transform: `translateY(${by}px)` }, { transform: 'none' }], { duration: CORRECT_MS, easing: EASE })
}

const storeKey = (): string => `cookrew-keyboard-cover:${window.innerHeight >= window.innerWidth ? 'tall' : 'wide'}`

/** The real page's side of the watch; `publish` is the inset hook's. */
export function pageKeyboardEnv(publish: KeyboardEnv['publish']): KeyboardEnv {
  return {
    publish,
    band: (px) => document.documentElement.style.setProperty('--kb-band', `${px}px`),
    recall() {
      try {
        const kept = window.localStorage.getItem(storeKey())
        const px = kept === null ? Number.NaN : Number(kept)
        return Number.isFinite(px) && px >= 0 ? px : null
      } catch {
        return null
      }
    },
    remember(cover) {
      try {
        window.localStorage.setItem(storeKey(), String(cover))
      } catch {
        // Private mode: the next focus guesses again.
      }
    },
    viewHeight: () => window.innerHeight,
    touch: () => typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches
  }
}

let live: KeyboardWatch | null = null

/** The inset hook's watch, while it runs. */
export function setLiveKeyboard(watch: KeyboardWatch | null): void {
  live = watch
}

export const expectKeyboard = (): number => live?.expect() ?? 0
export const keyboardLeaving = (): void => live?.leaving()
