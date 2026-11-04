/**
 * THE FACE FLIES TO THE BOX'S LEFT (owner, 2026-11-04: "the avatar becomes
 * the agent and its name, and moves with an animation to the far left"). The
 * folded face's last place on the bar, and the chip's face in the open box: the
 * chip's face is drawn from the first and settles into the second (a FLIP);
 * the box opens leftward behind it, its edge riding with the face, and the
 * name fades in. Transform, clip and opacity only.
 */

export interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** The move that draws `to` where `from` was (transform-origin 0 0); null when either has no size. */
export function flipFrom(from: Box, to: Box): { dx: number; dy: number; s: number } | null {
  if (!(from.width > 0) || !(to.width > 0)) return null
  return { dx: from.left - to.left, dy: from.top - to.top, s: from.width / to.width }
}

export const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
export const FLY_MS = 360

/** The reader asked for less motion: opacity only, nothing scales or clips. */
export const still = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** How far in from the box's left its clip starts: at the folded face's left, so the face is never cut. */
export function clipFrom(from: Box, box: Box): number {
  return Math.max(0, Math.min(box.width, from.left - box.left - 4))
}

/** Up from the foot ahead of a rising keyboard: quicker than a keyboard, so it is never under it. */
export const RISE_MS = 220

/** The box stands where the expected keyboard leaves it (keyboard-expect.ts): drawn from the foot, it rises there. */
export function riseBox(box: HTMLElement | null, rise: number): void {
  if (!box || !(rise > 0) || typeof box.animate !== 'function' || still()) return
  box.animate([{ transform: `translateY(${rise}px)` }, { transform: 'none' }], { duration: RISE_MS, easing: EASE })
}

/**
 * Fly the chip's face from the folded face's place; the box opens behind it,
 * the rest fades in. With a keyboard coming (`rise`) the box rises with it and
 * the face rides inside it, so the face's own move takes the rise out.
 */
export function flyFace(
  face: HTMLElement,
  from: Box,
  { box, rest, rise = 0 }: { box: HTMLElement | null; rest: readonly (HTMLElement | null)[]; rise?: number }
): void {
  if (typeof face.animate !== 'function') return
  riseBox(box, rise)
  const move = flipFrom(from, face.getBoundingClientRect())
  if (!move) return
  for (const el of rest) el?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: still() ? 120 : 240, delay: still() ? 0 : 140, easing: 'ease-out', fill: 'backwards' })
  if (still()) return
  if (box) {
    const r = box.getBoundingClientRect()
    const round = `round ${Math.min(24, r.height / 2)}px`
    box.animate([{ clipPath: `inset(0 0 0 ${clipFrom(from, r)}px ${round})` }, { clipPath: `inset(0 0 0 0 ${round})` }], { duration: FLY_MS, easing: EASE })
  }
  face.animate(
    [{ transform: `translate(${move.dx}px, ${move.dy - rise}px) scale(${move.s})` }, { transform: 'none' }],
    { duration: FLY_MS, easing: EASE }
  )
}

/** Another agent took the box: its face pops in where the last one was. */
export function popFace(face: HTMLElement): void {
  if (typeof face.animate !== 'function' || still()) return
  face.animate([{ transform: 'scale(0.6)', opacity: 0.3 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.6 }, { transform: 'none' }], { duration: 320, easing: EASE })
}
