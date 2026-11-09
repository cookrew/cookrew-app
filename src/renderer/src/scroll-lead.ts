/**
 * THE PICTURE MOVES WHEN THE FINGER DOES.
 *
 * Over the relay a finger's move takes a few hundred milliseconds to reach the
 * Mac and its picture as long to come back, so a swipe felt like dragging
 * something through mud. The picture is ours to move, though: it follows the
 * finger at once, and each frame takes back exactly what the page has really
 * scrolled, which every frame reports (`scrollY`). What is left is only what is
 * still on its way, and it reaches zero when the line catches up.
 *
 * It can be wrong in one way: the page does not scroll at all, because it is at
 * its end, or the finger is on a map or an inner list. Then nothing ever takes
 * the lead back, so it lets go after LEAD_PATIENCE_MS with no movement.
 *
 * Pure. Distances are view pixels unless named otherwise; a finger moving down is
 * positive, and moves the picture down, which is the page scrolling up.
 */

export const LEAD_PATIENCE_MS = 1000
/** Finger travel before a touch is a swipe and not a tap. */
export const LEAD_SLOP_PX = 8

export interface Lead {
  /** Where the page was when the finger came down, in CSS pixels; null when it does not say. */
  readonly startScroll: number | null
  readonly scroll: number | null
  /** How far the page has been asked to move. */
  readonly asked: number
  /** When anything last showed the page answering. */
  readonly progressAt: number
}

export const startLead = ({ scrollY, at }: { scrollY: number | null; at: number }): Lead => ({
  startScroll: scrollY,
  scroll: scrollY,
  asked: 0,
  progressAt: at
})

export const leadMoved = (lead: Lead, asked: number, at: number): Lead => ({
  ...lead,
  asked,
  progressAt: lead.asked === 0 ? at : lead.progressAt
})

export const leadFrame = (lead: Lead, scrollY: number | null, at: number): Lead => {
  // Under a pixel is rounding: the screencast and a still report the same page apart.
  if (scrollY === null || lead.scroll === null || Math.abs(scrollY - lead.scroll) < 1) return lead
  return { ...lead, scroll: scrollY, progressAt: at }
}

/** View pixels per CSS pixel. */
export const viewPerCss = (fitWidth: number, deviceWidth: number, pageScale: number): number =>
  deviceWidth > 0 ? (fitWidth / deviceWidth) * pageScale : 0

/** The page has really moved since the finger came down. */
export const leadAnswered = (lead: Lead): boolean => lead.scroll !== null && lead.scroll !== lead.startScroll

export const leadStalled = (lead: Lead, now: number): boolean => now - lead.progressAt > LEAD_PATIENCE_MS

/** Where the picture should sit now, relative to where the frame draws it. */
export function leadOffset(lead: Lead, perCss: number, now: number): number {
  if (lead.startScroll === null || lead.scroll === null || perCss <= 0 || leadStalled(lead, now)) return 0
  const moved = -(lead.scroll - lead.startScroll) * perCss
  const left = lead.asked - moved
  // Past the finger means the page ran ahead: nothing is owed.
  if (Math.sign(left) !== Math.sign(lead.asked)) return 0
  return left > 0 ? Math.min(left, lead.scroll * perCss) : left
}

const MIN_PINCH_LEAD = 0.25
const MAX_PINCH_LEAD = 4

/** The scale still owed: what the fingers asked over what the page has done. */
export function pinchLeadScale(asked: number, startScale: number | null, scaleNow: number | null): number {
  if (startScale === null || scaleNow === null || startScale <= 0 || scaleNow <= 0) return 1
  return Math.min(MAX_PINCH_LEAD, Math.max(MIN_PINCH_LEAD, asked / (scaleNow / startScale)))
}

export interface FingerSample {
  readonly y: number
  readonly at: number
}

/** The window that decides a flick: the swipe's end, not its whole. */
const FLING_WINDOW_MS = 100
const FLING_MIN_SPEED = 0.25
const FLING_STOP_SPEED = 0.05
/** Close to how far a phone's own list runs on. */
const FLING_DECAY_MS = 325

/** View pixels per millisecond at the lift; 0 when it was no flick. */
export function flingVelocity(samples: readonly FingerSample[]): number {
  const last = samples.at(-1)
  if (!last) return 0
  const recent = samples.filter((sample) => last.at - sample.at <= FLING_WINDOW_MS)
  const first = recent[0]
  if (recent.length < 2 || last.at === first.at) return 0
  const speed = (last.y - first.y) / (last.at - first.at)
  return Math.abs(speed) < FLING_MIN_SPEED ? 0 : speed
}

/** One step of a flick; null when it has stopped. */
export function flingStep(velocity: number, ms: number): { delta: number; velocity: number } | null {
  if (Math.abs(velocity) < FLING_STOP_SPEED) return null
  return { delta: velocity * ms, velocity: velocity * Math.exp(-ms / FLING_DECAY_MS) }
}
