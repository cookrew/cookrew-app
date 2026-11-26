/**
 * A PHONE'S VIEWPORT ASK HOLDS STILL (owner's Android phone, 2026-11-26).
 *
 * The live view asks the Mac for a viewport, and every new ask resizes the
 * card's headless page, which restarts the H.264 encoder and sends a key
 * frame. The same card flipped 768x1586 / 768x1580 / 522x1074 as it moved
 * between hosts (a terminal's lower half, an item full view with side
 * padding, a zoom on its way in) and the view froze for a minute and a half.
 *
 * So on a phone the ask is not the box:
 *   • its WIDTH is the page's own layout width, the same in every host; only
 *     turning the phone changes it;
 *   • its HEIGHT follows the box, but a move under ASK_HEIGHT_SLACK_PX from
 *     the last ask sent is not a new ask (an address bar, sub-pixel rounding);
 *   • while the box paints at another size than it lays out at (a CSS scale
 *     mid-zoom) nothing is asked; the ask goes once it settles, or after
 *     ASK_HOLD_MAX_MS for a box that stays scaled.
 * The box itself still drives the local letterbox, which already fits a
 * picture of another shape (browser-frame.ts · fitContain).
 *
 * The desktop app, the demo and a remote viewer with a mouse keep asking the
 * box, exactly as before. Pure — unit-tested (tests/viewport-steady.test.ts).
 */

import type { StreamClient, ViewportSize } from './browser-stream'
import { VIEWPORT_MAX } from '../../shared/cast-viewport'

/** A height move smaller than this, from the last ask sent, is not asked (CSS px). */
export const ASK_HEIGHT_SLACK_PX = 24
/** Painted and laid-out sizes this close are the same box (borders, rounding). */
export const ASK_TRANSFORM_SLACK_PX = 3
/** A held ask looks again this often: a transform ending fires no resize. */
export const ASK_SETTLE_RECHECK_MS = 120
/** A box still scaled after this long is scaled for good (a card at a stop's size). */
export const ASK_HOLD_MAX_MS = 1500

/** 'steady' for a phone; 'box' asks the box as it is, for everyone else. */
export type AskMode = 'steady' | 'box'

export interface BoxReading {
  /** The content box the frame measures (what the letterbox fits). */
  readonly box: ViewportSize
  /** offsetWidth/offsetHeight: the box's size before any transform. */
  readonly layout: ViewportSize
  /** getBoundingClientRect: what it paints at, every ancestor's transform included. */
  readonly painted: ViewportSize
  /** The page's layout width for this orientation; 0 when it has none to give. */
  readonly pageWidth: number
}

export interface SteadyState {
  /** The last ask handed on to be sent; null before the first. */
  readonly sent: ViewportSize | null
  /** When the box was first seen scaled in its current run; null at rest. */
  readonly heldSince: number | null
}

export type AskDecision =
  | { readonly kind: 'send'; readonly ask: ViewportSize }
  | { readonly kind: 'keep' }
  | { readonly kind: 'hold' }

export interface AskStep {
  readonly state: SteadyState
  readonly decision: AskDecision
}

export const EMPTY_STEADY: SteadyState = { sent: null, heldSince: null }

/** A phone is a remote viewer with a touch screen; nobody else gets a steady ask. */
export function askMode(client: StreamClient, coarsePointer: boolean): AskMode {
  return client === 'remote' && coarsePointer ? 'steady' : 'box'
}

function rounded(size: ViewportSize): ViewportSize {
  return { width: Math.round(size.width), height: Math.round(size.height) }
}

function measured(size: ViewportSize): boolean {
  return size.width > 0 && size.height > 0
}

function sameSize(a: ViewportSize | null, b: ViewportSize): boolean {
  return a !== null && a.width === b.width && a.height === b.height
}

/** The box paints at another size than it lays out at: a CSS scale is on it. */
export function transformed(reading: BoxReading): boolean {
  const { layout, painted } = reading
  if (!measured(layout)) return false
  return (
    Math.abs(painted.width - layout.width) > ASK_TRANSFORM_SLACK_PX ||
    Math.abs(painted.height - layout.height) > ASK_TRANSFORM_SLACK_PX
  )
}

/**
 * The ask a phone would make from this reading: the page's width, and the box's SHAPE at that width
 * (review 2026-11-26). Taking the box's height as it was, a narrow host (261x537 on the owner's phone)
 * asked 384x537: the page resized all the same and a third of the box was empty bands. At the box's
 * shape it asks 384x790, within the slack of the full view's 384x793: one ask, and the picture fills it.
 */
export function steadySize(reading: BoxReading): ViewportSize {
  const { box } = reading
  if (!(reading.pageWidth > 0) || !(box.width > 0)) return rounded(box)
  const height = (box.height * reading.pageWidth) / box.width
  // Past the Mac's VIEWPORT_MAX it would cut the height alone and the shape would be lost (a narrow box on a
  // landscape tablet): both sides come down together instead.
  if (height <= VIEWPORT_MAX) return rounded({ width: reading.pageWidth, height })
  return rounded({ width: (reading.pageWidth * VIEWPORT_MAX) / height, height: VIEWPORT_MAX })
}

/**
 * How far the height may move before it is asked again: ASK_HEIGHT_SLACK_PX, or ASK_HEIGHT_SLACK_SHARE of
 * it on a tall page. A host 16 px narrower (the padded full view) is ~4% taller at the page's width, which
 * a fixed 24 px would have read as a new size.
 */
export const ASK_HEIGHT_SLACK_SHARE = 0.05
const heightSlack = (height: number): number => Math.max(ASK_HEIGHT_SLACK_PX, height * ASK_HEIGHT_SLACK_SHARE)

/** A new ask is worth a resize: the first, a turn of the phone, or a real height change. */
function worthAsking(last: ViewportSize | null, next: ViewportSize): boolean {
  if (last === null) return true
  if (next.width !== last.width) return true
  return Math.abs(next.height - last.height) >= heightSlack(last.height)
}

function boxStep(state: SteadyState, reading: BoxReading): AskStep {
  const ask = rounded(reading.box)
  if (!measured(ask) || sameSize(state.sent, ask)) return { state, decision: { kind: 'keep' } }
  return { state: { sent: ask, heldSince: null }, decision: { kind: 'send', ask } }
}

function steadyStep(state: SteadyState, reading: BoxReading, now: number): AskStep {
  if (!measured(reading.box)) return { state, decision: { kind: 'keep' } }
  const heldSince = transformed(reading) ? (state.heldSince ?? now) : null
  if (heldSince !== null && now - heldSince < ASK_HOLD_MAX_MS) {
    return { state: { ...state, heldSince }, decision: { kind: 'hold' } }
  }
  const ask = steadySize(reading)
  if (!worthAsking(state.sent, ask)) return { state: { ...state, heldSince }, decision: { kind: 'keep' } }
  return { state: { sent: ask, heldSince }, decision: { kind: 'send', ask } }
}

/** One reading of the box: the next state, and whether an ask goes, waits, or is not needed. */
export function stepAsk(state: SteadyState, reading: BoxReading, mode: AskMode, now: number): AskStep {
  return mode === 'box' ? boxStep(state, reading) : steadyStep(state, reading, now)
}

/** What the box reading needs of an element, a document and a window (duck-typed for tests). */
export interface BoxElement {
  readonly offsetWidth: number
  readonly offsetHeight: number
  getBoundingClientRect: () => { readonly width: number; readonly height: number }
}

/** Read the box, its paint and the page's width in one go. */
export function readBox(
  el: BoxElement,
  box: { readonly w: number; readonly h: number },
  doc: { readonly documentElement: { readonly clientWidth: number } | null },
  win: { readonly innerWidth: number }
): BoxReading {
  const rect = el.getBoundingClientRect()
  const root = doc.documentElement?.clientWidth ?? 0
  return {
    box: { width: box.w, height: box.h },
    layout: { width: el.offsetWidth, height: el.offsetHeight },
    painted: { width: rect.width, height: rect.height },
    pageWidth: root > 0 ? root : win.innerWidth
  }
}
