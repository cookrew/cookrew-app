// The motion language's numbers that other parts build to (motion.html §13–14),
// in one place: Usher's top bar and fan and Harbor's frame layer import them
// instead of copying them. Durations in ms; easings are CSS strings for Web
// Animations or CSS animations, transform and opacity only.
import { SPRING, cssOf } from './easing'

const EASE_OUT = 'cubic-bezier(0.2, 0, 0, 1)'
const EASE_IN = 'cubic-bezier(0.5, 0, 0.75, 0)'

/**
 * Level 3's two fades. The frame (the companion's real terminal) shows over the
 * stage's terminal pane once BOTH the stage rests at that terminal (stageRest)
 * and the embed is shown (EmbedPool.state().shown): never mid-flight, where a
 * still frame would sit on a moving pane. On the way out the frame dissolves
 * from the moment close() is called, which is the out flight's take-off, so
 * the real terminal crossfades into the pane that is already shrinking home.
 * The same numbers hold under reduced motion: they are opacity only, the same
 * 120 ms crossfade every reduced flight is.
 */
export const LEVEL3 = {
  /** The frame, in over the pane: from max(stage rests at the terminal, embed shown). */
  frameIn: { ms: 120, easing: EASE_OUT },
  /** The shell's top bar, out: together with frameIn, so the terminal gets the screen as it arrives. */
  barOut: { ms: 120, easing: 'linear' },
  /** The frame, out: from close() (the way out's take-off), over the flight's first 120 ms. */
  frameOut: { ms: 120, easing: 'linear' },
  /** The top bar, back: from close() too, so the crumbs say where the camera is going. */
  barIn: { ms: 160, easing: EASE_OUT }
} as const

/**
 * The attachment fan (Usher draws it): cards come out from behind the avatar
 * on hover intent (or press-and-hold), each on a straight line from the
 * avatar's centre to its seat on the arc, turning to its tilt and growing from
 * 0.6, opaque by 35% of its run, in connection order with a short stagger.
 * They tuck back the way they came, last card first. Transform and opacity
 * only, never margin or top (those lay out every frame).
 */
export const FAN = {
  out: { ms: 160, stagger: 20, easing: cssOf(SPRING) },
  back: { ms: 120, stagger: 12, easing: EASE_IN },
  /** Scale a card starts from, behind the avatar. */
  fromScale: 0.6,
  /** Share of the run by which a card is fully opaque (it emerges from behind the avatar). */
  opaqueAt: 0.35,
  /** Reduced motion: no travel, no turn, all cards at once. */
  reduced: { ms: 120, stagger: 0, easing: 'linear' }
} as const

/** Wall time until the last of `count` cards is out (or back). */
export const fanTotal = (count: number, phase: 'out' | 'back', reduced = false): number => {
  const t = reduced ? FAN.reduced : FAN[phase]
  return t.ms + Math.max(0, count - 1) * t.stagger
}
