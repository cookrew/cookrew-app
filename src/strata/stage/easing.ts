// The stage's curves (docs/strata-2026-10-21/glide/motion.html §3). Each is
// kept twice on purpose: the CSS string goes to Web Animations (the compositor
// runs it), the solver is for the math that has to agree with it (settle
// velocity, tests, the spec's plot).

export type Bezier = readonly [x1: number, y1: number, x2: number, y2: number]

/** in, out, hop: felix's shape (0.57,0,0.34,1) with a quicker launch, because a click must answer within a frame. */
export const FLY: Bezier = [0.45, 0, 0.15, 1]
/** dive / rise: a steadier middle so the camera passes through the levels instead of stopping in each. */
export const DIVE: Bezier = [0.4, 0, 0.2, 1]
/** rubber-band home. */
export const SPRING: Bezier = [0.2, 0.9, 0.25, 1]

export const cssOf = ([x1, y1, x2, y2]: Bezier): string => `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`

/** After a scrub: launch at the finger's speed (`slope` = du/dt normalised to the remaining distance and time). */
export const settleCurve = (slope: number): Bezier => {
  const x1 = 0.25
  const y1 = Math.min(1, Math.max(0, x1 * slope))
  return [x1, Number(y1.toFixed(3)), 0.1, 1]
}

/** y for x on a cubic-bezier timing curve (x and y in 0..1), by bisection: exact enough for keyframes and tests. */
export const ease = ([x1, y1, x2, y2]: Bezier, x: number): number => {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t
  let lo = 0
  let hi = 1
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (bx(mid) < x) lo = mid
    else hi = mid
  }
  return by((lo + hi) / 2)
}
