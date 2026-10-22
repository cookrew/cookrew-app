// The one read per flight: every rect the camera needs, at take-off, with all
// scenes at identity. Scroll is settled first (each level gets back the framing
// it was last flown with, and an off-screen anchor is brought into view);
// afterwards every level of the flight remembers its framing (framing.ts), and
// nothing reads layout until the next take-off.
import type { Rect } from '../../shared/strata'
import { findAnchor, type AnchorRegistry } from './anchors'
import { visibleShare } from './camera'
import { framingToRestore, rememberFraming, type Framing } from './framing'
import { pathKey } from './plan'
import type { ActivePlan } from './stage-state'
import { geometryOf, type FlightGeometry, type StepRects } from './timeline'

export interface SceneLookup {
  el(key: string): HTMLElement | undefined
  registry(key: string): AnchorRegistry | undefined
  framing: { current: Framing }
}

/** An anchor under this share on screen is scrolled into view before take-off. */
const IN_VIEW = 0.6

export const measureFlight = (root: HTMLElement, plan: ActivePlan, scenes: SceneLookup, reduced: boolean): FlightGeometry => {
  const box = root.getBoundingClientRect()
  const viewport: Rect = { x: 0, y: 0, w: box.width, h: box.height }
  const fromKey = pathKey(plan.from)
  const fromEl = scenes.el(fromKey)
  // The level we leave keeps the framing the user left it at.
  if (fromEl) scenes.framing.current = rememberFraming(scenes.framing.current, [[fromKey, fromEl.scrollTop]])
  for (const [key, top] of framingToRestore(plan, scenes.framing.current)) {
    const el = scenes.el(key)
    if (el) el.scrollTop = top
  }
  const geometry = reduced || plan.kind === 'hop' ? geometryOf(plan, [], viewport, reduced) : measureSteps(plan, scenes, box, viewport)
  // Every level of the flight remembers the framing it was flown with, so the way back lands on it exactly.
  const flown = plan.scenes.map(pathKey).flatMap((key): Array<[string, number]> => {
    const el = scenes.el(key)
    return el ? [[key, el.scrollTop]] : []
  })
  scenes.framing.current = rememberFraming(scenes.framing.current, flown)
  return geometry
}

const measureSteps = (plan: ActivePlan, scenes: SceneLookup, box: DOMRect, viewport: Rect): FlightGeometry => {
  const rel = (r: DOMRect): Rect => ({ x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height })
  const anchors = plan.steps.map((step) => findAnchor(scenes.registry(pathKey(step.parent)), step.anchor))
  // Two passes. In a dive a step's child is the next step's parent, so scrolling a later anchor into
  // view moves an earlier step's content: every level is scrolled first, and only then is anything read.
  plan.steps.forEach((step, i) => {
    const found = anchors[i]
    const parentEl = scenes.el(pathKey(step.parent))
    if (!found || !parentEl) return
    const anchor = rel(found.el.getBoundingClientRect())
    if (visibleShare(anchor, viewport) < IN_VIEW) parentEl.scrollTop += anchor.y + anchor.h / 2 - viewport.h / 2
  })
  const rects = plan.steps.map((step, i): StepRects => {
    const found = anchors[i]
    const anchor = found ? rel(found.el.getBoundingClientRect()) : null
    const content = findAnchor(scenes.registry(pathKey(step.child)), step.content)
    return {
      anchor: anchor && visibleShare(anchor, viewport) > 0 ? anchor : null,
      content: content ? rel(content.el.getBoundingClientRect()) : null
    }
  })
  return geometryOf(plan, rects, viewport, false)
}
