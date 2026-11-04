import { EASE, clipFrom, flipFrom, still, type Box } from './face-flip'
import type { FacePlace } from './prompt-fold'

/**
 * THE FACE FLIES BACK (owner design 2026-11-04, motion table: "Fold (deselect
 * / Esc): reverse: the chip's face flies back to the bar's end, the box clips
 * shut toward it; the draft dot pops in · 300 ms"). The reverse of face-flip.ts
 * flyFace: the folded face is drawn from the chip's last place and settles at
 * the bar's end; the open box, hidden by the fold's own commit, is shut by a
 * ghost: a fixed copy of it taken in the render that folds it, while the DOM
 * still showed it open. The dock paints over the stage, so the ghost would
 * cover the real face on the bar: a stand-in of the face flies over the ghost
 * and hands over as it lands. Transform, clip and opacity only.
 */

export const FOLD_MS = 300

/**
 * With the keyboard up the bar's end is under it, and the page hears of it
 * going only once it has gone: the flight waits this long, then follows it
 * down, its easing front-loaded, so the face stays over the keyboard's falling
 * edge instead of diving behind it.
 */
export const KEYBOARD_HOLD_MS = 120

/** Where the box stood: folded or not, the view's place for the face, and whether the face had it then. */
export interface FoldSeen {
  readonly folded: boolean
  readonly place: FacePlace
  /** The face's place was there (the bar's slot mounted, or the corner): the box could fold. */
  readonly placed: boolean
}

/**
 * A fold flies back only where the box stood open a moment ago and could have
 * folded: never across views, and never when the bar's slot only now appears
 * (the zoom mounts after the dock: at launch, back to the stage).
 */
export function fliesBack(was: FoldSeen, now: FoldSeen): boolean {
  return !was.folded && now.folded && was.place === now.place && was.placed
}

export interface FoldSnapshot {
  /** The open box, where it stood. */
  readonly box: Box
  /** The chip's face in it, mid-flight or at rest. */
  readonly face: Box | null
  /** How the box lays its row out: the ghost keeps it while the fold hides the box. */
  readonly display: string
  /** Where its own clip stood (a fold mid-open shuts from there); 'none' at rest. */
  readonly clip: string
  /** A copy of the box, not yet in the page. */
  readonly ghost: HTMLElement | null
}

const boxOf = (r: DOMRect): Box => ({ left: r.left, top: r.top, width: r.width, height: r.height })

/**
 * The open box as it stands. Read in the render that folds it (the commit is
 * about to hide it): its place, the chip's face, and a copy to shut.
 */
export function snapshotBox(form: HTMLElement | null, chipFace: HTMLElement | null): FoldSnapshot | null {
  if (!form || typeof form.getBoundingClientRect !== 'function') return null
  const box = boxOf(form.getBoundingClientRect())
  if (!(box.width > 0)) return null
  const face = chipFace ? boxOf(chipFace.getBoundingClientRect()) : null
  const style = getComputedStyle(form)
  return { box, face: face && face.width > 0 ? face : null, display: style.display, clip: style.clipPath, ghost: form.cloneNode(true) as HTMLElement }
}

/**
 * Put the copy where the box was, beside it (so the box's own rules still
 * dress it), out of every reader's and pointer's way. Its chip's face is
 * hidden: the real one is flying from there.
 */
export function stageGhost(snap: FoldSnapshot, beside: HTMLElement): HTMLElement | null {
  const ghost = snap.ghost
  if (!ghost) return null
  ghost.classList.add('pf-leaving')
  ghost.classList.remove('folded')
  ghost.setAttribute('aria-hidden', 'true')
  ghost.setAttribute('inert', '')
  ghost.removeAttribute('id')
  for (const el of ghost.querySelectorAll('[id]')) el.removeAttribute('id')
  // Open menus (the picker, a harness or name list) leave with the fold, not with the box.
  for (const el of ghost.querySelectorAll('[role="listbox"], [role="menu"], [role="status"], [role="alert"]')) el.remove()
  for (const el of ghost.querySelectorAll<HTMLElement>('.pf-chip-face')) el.style.visibility = 'hidden'
  ghost.style.display = snap.display
  placeFixed(ghost, snap.box, beside)
  return ghost
}

/** Put `el` exactly on `box`, fixed, right after `beside`, out of the pointer's way. */
function placeFixed(el: HTMLElement, box: Box, beside: HTMLElement): void {
  Object.assign(el.style, {
    position: 'fixed',
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    margin: '0',
    boxSizing: 'border-box',
    pointerEvents: 'none'
  })
  beside.after(el)
  // A transformed ancestor would carry `fixed` along with it: land it exactly.
  const at = el.getBoundingClientRect()
  el.style.left = `${box.left * 2 - at.left}px`
  el.style.top = `${box.top * 2 - at.top}px`
}

/**
 * A copy of the folded face, right over the ghost, to fly in its place. Its
 * dot stays with the real face, which pops it in on landing. None under reduced
 * motion: nothing flies.
 */
export function stageFlyer(face: HTMLElement, ghost: HTMLElement | null): HTMLElement | null {
  if (!ghost || still()) return null
  const flyer = face.cloneNode(true) as HTMLElement
  for (const name of ['id', 'title', 'aria-describedby', 'aria-label']) flyer.removeAttribute(name)
  flyer.setAttribute('aria-hidden', 'true')
  flyer.setAttribute('inert', '')
  flyer.setAttribute('tabindex', '-1')
  flyer.querySelector('.pf-dot')?.remove()
  placeFixed(flyer, face.getBoundingClientRect(), ghost)
  return flyer
}

/** How far the box's clip comes in on each side to shut round the face (4px clear of it). */
export function shutInsets(face: Box, box: Box, pad = 4): { top: number; right: number; bottom: number; left: number } {
  const clamp = (n: number, max: number): number => Math.max(0, Math.min(max, n))
  const left = clamp(face.left - pad - box.left, box.width)
  const top = clamp(face.top - pad - box.top, box.height)
  return {
    top,
    right: clamp(box.left + box.width - (face.left + face.width + pad), box.width - left),
    bottom: clamp(box.top + box.height - (face.top + face.height + pad), box.height - top),
    left
  }
}

/** The bar clips back open out of the face once the box has shut into it. */
export const BAR_MS = 160

interface Flight {
  /** Every run it started, stopped together. */
  readonly runs: Animation[]
  play(el: HTMLElement | null, frames: Keyframe[], options: KeyframeAnimationOptions): Animation | null
}

function flight(): Flight {
  const runs: Animation[] = []
  return {
    runs,
    play(el, frames, options) {
      const run = el?.animate?.(frames, options) ?? null
      if (run) runs.push(run)
      return run
    }
  }
}

/** Reduced motion: opacity only, nothing scales or clips, and the bar is not held back. */
function fadeBack(f: Flight, face: HTMLElement, ghost: HTMLElement | null, stop: () => void): void {
  f.play(face, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' })
  f.play(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-out', fill: 'forwards' })?.finished.then(stop, stop)
}

/** The face (its stand-in, the real one waiting unseen) from the chip's place to the bar's end, or, with no chip, fading in; its dot pops in as it lands. */
function landFace(f: Flight, face: HTMLElement, flyer: HTMLElement | null, from: Box | null, to: Box, dot: HTMLElement | null, hold: number): void {
  const move = from ? flipFrom(from, to) : null
  if (flyer) f.play(face, [{ opacity: 0 }, { opacity: 0 }], { duration: hold + FOLD_MS })
  const flying = flyer ?? face
  if (move) {
    f.play(
      flying,
      [
        { transformOrigin: '0 0', transform: `translate(${move.dx}px, ${move.dy}px) scale(${move.s})` },
        { transformOrigin: '0 0', transform: 'none' }
      ],
      { duration: FOLD_MS, delay: hold, easing: EASE, fill: 'backwards' }
    )
  } else f.play(flying, [{ opacity: 0 }, { opacity: 1 }], { duration: FOLD_MS / 2, delay: hold + FOLD_MS / 2, easing: 'ease-out', fill: 'backwards' })
  f.play(dot, [{ transform: 'scale(0)' }, { transform: 'scale(1.3)', offset: 0.6 }, { transform: 'none' }], {
    duration: 200,
    delay: hold + FOLD_MS - 40,
    easing: 'ease-out',
    fill: 'backwards'
  })
}

/**
 * The ghost clips shut onto the face, from where its clip stood, and fades as
 * it closes. With the keyboard going (`cover`) it sinks with it to the foot,
 * and shuts there.
 */
function shutBox(f: Flight, ghost: HTMLElement, snap: FoldSnapshot, to: Box, cover: number, hold: number): Animation | null {
  const i = shutInsets(to, { ...snap.box, top: snap.box.top + cover })
  const shut = `inset(${i.top}px ${i.right}px ${i.bottom}px ${i.left}px round ${to.height / 2 + 4}px)`
  const from = snap.clip && snap.clip !== 'none' ? snap.clip : `inset(0px 0px 0px 0px round ${Math.min(24, snap.box.height / 2)}px)`
  const sunk = cover > 0 ? { transform: `translateY(${cover}px)` } : {}
  return f.play(
    ghost,
    [
      { clipPath: from, opacity: 1, ...(cover > 0 ? { transform: 'none' } : {}) },
      // Late, so its edge rides with the face and only the last of it fades.
      { clipPath: shut, opacity: 1, offset: 0.95, ...sunk },
      { clipPath: shut, opacity: 0, ...sunk }
    ],
    { duration: FOLD_MS, delay: hold, easing: EASE, fill: 'both' }
  )
}

/** The bar clips back open leftward out of the face. */
function unrollBar(bar: HTMLElement, to: Box): void {
  if (typeof bar.animate !== 'function') return
  const r = bar.getBoundingClientRect()
  bar.animate([{ clipPath: `inset(0 0 0 ${Math.max(0, to.left - r.left - 4)}px round 999px)` }, { clipPath: 'inset(0 0 0 0 round 999px)' }], {
    duration: BAR_MS,
    easing: EASE
  })
}

/**
 * Fly the folded face back from the chip's place; the box (its ghost) clips
 * shut onto it, its left edge riding with the face; the draft dot pops in as
 * the face lands. The bar, which would show through the box as it shuts and
 * fades, holds its chrome back meanwhile (`page` gets cr-prompt-landing, as
 * while the box was open), then clips back open leftward out of the face,
 * the reverse of the box's open, from half-way. The returned function stops
 * it all at once (a re-open mid-flight, the box going away): the bar comes
 * back without unrolling.
 */
export function flyBack(
  face: HTMLElement,
  snap: FoldSnapshot,
  {
    dot,
    bar,
    page,
    cover = 0,
    flyer = null
  }: {
    dot: HTMLElement | null
    bar: HTMLElement | null
    page: { readonly classList: DOMTokenList } | null
    /** The keyboard's cover as the fold begins: it is going down with the box's focus. */
    cover?: number
    /** The face's stand-in over the ghost (stageFlyer). */
    flyer?: HTMLElement | null
  }
): () => void {
  const ghost = snap.ghost
  const hold = cover > 0 ? KEYBOARD_HOLD_MS : 0
  const f = flight()
  let done = false
  let guard: ReturnType<typeof setTimeout> | null = null
  const stop = (): void => {
    if (done) return
    done = true
    if (guard !== null) clearTimeout(guard)
    for (const run of f.runs) run.cancel?.()
    ghost?.remove()
    flyer?.remove()
    page?.classList.remove(LANDING)
  }
  if (typeof face.animate !== 'function') {
    stop()
    return stop
  }
  // An animation settles only on a frame: a hidden page never paints one, so
  // the ghost is let go on time regardless.
  if (ghost) guard = setTimeout(stop, (still() ? 120 : hold + FOLD_MS) + 150)
  if (still()) {
    fadeBack(f, face, ghost, stop)
    return stop
  }
  const to = face.getBoundingClientRect()
  landFace(f, face, flyer, snap.face, to, dot, hold)
  if (!ghost) return stop
  if (bar) page?.classList.add(LANDING)
  shutBox(f, ghost, snap, to, cover, hold)?.finished.then(stop, stop)
  // Half-way the box has all but shut into the face (the easing front-loads
  // the move): the bar clips back open out of it, over what is left. Timed on
  // the flight's own clock (a still half-length run), so a slowed or paused
  // timeline keeps the two together.
  const reveal = (): void => {
    if (done) return
    page?.classList.remove(LANDING)
    if (bar) unrollBar(bar, to)
  }
  f.play(ghost, [], { duration: FOLD_MS / 2, delay: hold })?.finished.then(reveal, () => undefined)
  return stop
}

/** On the page while the box shuts over the bar's place (prompt-motion.css). */
const LANDING = 'cr-prompt-landing'
