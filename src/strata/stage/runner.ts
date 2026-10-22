// Plays one flight on the DOM with Web Animations: transforms and opacity
// only, so the compositor runs it and the main thread does nothing per frame
// (the stage sets will-change before it measures, and clears it at landing).
// A scrub is the same animations paused, moved by currentTime; its release
// re-samples the rest of the path with a curve that launches at the finger's
// speed.
import { cssOf, settleCurve } from './easing'
import { framesFor, type FlightFrames, type FlightGeometry } from './timeline'

export interface FlightLayers {
  /** One per scene of the plan, shallow → deep (hop: from, to). */
  scenes: HTMLElement[]
  coarse: HTMLElement
  fine: HTMLElement
}

export type Landing = 'to' | 'from'

export interface Runner {
  readonly id: number
  readonly geometry: FlightGeometry
  readonly duration: number
  readonly elements: ReadonlySet<Element>
  /** Plays to the end; resolves where it landed, or never if replaced. */
  play(): Promise<Landing>
  /** Paused at progress p (a scrub). */
  scrub(p: number): void
  progress(): number
  /** From the scrub position to the end (commit) or the start (spring back). `speed` is progress per ms toward the end. */
  settle(commit: boolean, speed: number): Promise<Landing>
  /** Turn the running flight round in place, toward the end it was leaving; resolves there. */
  reverse(): Promise<Landing>
  /** Remove every animation of this flight from these elements (a newer flight animates them now), or from all. */
  release(only?: ReadonlySet<Element>): void
}

const SETTLE_MIN = 160
const SETTLE_MAX = 420

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export const createRunner = (id: number, geometry: FlightGeometry, layers: FlightLayers, duration: number, easing: string, scrub: boolean): Runner => {
  const targets: Array<[HTMLElement, (f: FlightFrames) => Keyframe[]]> = [
    ...layers.scenes.map((el, i): [HTMLElement, (f: FlightFrames) => Keyframe[]] => [el, (f) => f.scenes[i]]),
    [layers.coarse, (f) => f.coarse],
    [layers.fine, (f) => f.fine]
  ]
  const elements = new Set<Element>(targets.map(([el]) => el))
  let anims: Animation[] = []
  let span: [number, number] = [0, 1]
  let span_ms = duration
  // Whether the animations run toward span[1] (false once reversed in place).
  let towardEnd = true
  // Every play/settle/reverse/release starts a new generation; only the current one may land.
  let gen = 0

  const start = (p0: number, p1: number, ms: number, curve: string): Animation[] => {
    const frames = framesFor(geometry, p0, p1)
    const timing: KeyframeAnimationOptions = { duration: ms, easing: curve, fill: 'both' }
    const next = targets.map(([el, pick]) => el.animate(pick(frames), timing))
    // Old animations go after the new ones exist, so no frame shows the bare styles.
    anims.forEach((a) => a.cancel())
    anims = next
    span = [p0, p1]
    span_ms = ms
    towardEnd = true
    return next
  }

  const landing = (at: Landing): Promise<Landing> => {
    const mine = ++gen
    return new Promise((resolve) => {
      anims[0].finished.then(
        () => mine === gen && resolve(at),
        () => undefined
      )
    })
  }

  start(0, 1, duration, scrub ? 'linear' : easing)
  if (scrub) anims.forEach((a) => a.pause())

  return {
    id,
    geometry,
    duration,
    elements,
    play: () => landing('to'),
    scrub: (p) => {
      const t = clamp(p, 0, 1) * span_ms
      anims.forEach((a) => (a.currentTime = t))
    },
    progress: () => {
      const t = Number(anims[0]?.currentTime ?? 0)
      const local = clamp(t / span_ms, 0, 1)
      return span[0] + (span[1] - span[0]) * local
    },
    settle(commit, speed) {
      const p0 = this.progress()
      const target = commit ? 1 : 0
      const remaining = Math.abs(target - p0)
      const ms = clamp(remaining * duration, SETTLE_MIN, SETTLE_MAX)
      // Launch slope of the curve = the finger's speed, normalised to this range and time.
      const toward = commit ? speed : -speed
      const slope = remaining > 0 ? (Math.max(0, toward) * ms) / remaining : 0
      start(p0, target, ms, cssOf(settleCurve(slope)))
      return landing(commit ? 'to' : 'from')
    },
    reverse() {
      const heading = towardEnd ? span[1] : span[0]
      const goal = heading === 1 ? 0 : 1
      // A whole flight plays its own curve backwards. A partial one (a committed scrub settling from
      // where the finger let go) would only get back to that point: it springs from here to the goal.
      if ((towardEnd ? span[0] : span[1]) === goal) {
        anims.forEach((a) => a.reverse())
        towardEnd = !towardEnd
      } else {
        const p0 = this.progress()
        start(p0, goal, clamp(Math.abs(goal - p0) * duration, SETTLE_MIN, SETTLE_MAX), cssOf(settleCurve(0)))
      }
      return landing(goal === 1 ? 'to' : 'from')
    },
    release(only) {
      gen += 1
      const keep: Animation[] = []
      for (const a of anims) {
        const target = (a.effect as KeyframeEffect | null)?.target
        if (!only || (target && only.has(target))) a.cancel()
        else keep.push(a)
      }
      anims = keep
    }
  }
}
