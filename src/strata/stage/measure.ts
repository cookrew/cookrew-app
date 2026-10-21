// The one read per flight: every rect the camera needs, at take-off, with all
// scenes at identity. Scroll is settled first (restore on the way out, bring
// an off-screen anchor into view); after this nothing reads layout until the
// next take-off.
import type { Rect } from '../../shared/strata'
import { findAnchor, type AnchorRegistry } from './anchors'
import { visibleShare } from './camera'
import { pathKey } from './plan'
import type { ActivePlan } from './stage-state'
import { geometryOf, type FlightGeometry, type StepRects } from './timeline'

export interface SceneLookup {
  el(key: string): HTMLElement | undefined
  registry(key: string): AnchorRegistry | undefined
  /** scrollTop each level had when the camera last left it. */
  scroll: Map<string, number>
}

/** An anchor under this share on screen is scrolled into view before take-off. */
const IN_VIEW = 0.6

export const measureFlight = (root: HTMLElement, plan: ActivePlan, scenes: SceneLookup, reduced: boolean): FlightGeometry => {
  const box = root.getBoundingClientRect()
  const viewport: Rect = { x: 0, y: 0, w: box.width, h: box.height }
  const fromKey = pathKey(plan.from)
  const fromEl = scenes.el(fromKey)
  if (fromEl) scenes.scroll.set(fromKey, fromEl.scrollTop)
  if (reduced || plan.kind === 'hop') return geometryOf(plan, [], viewport, reduced)

  for (const p of plan.scenes) {
    const key = pathKey(p)
    const top = scenes.scroll.get(key)
    const el = scenes.el(key)
    if (key !== fromKey && el && top !== undefined) el.scrollTop = top
  }
  const rel = (r: DOMRect): Rect => ({ x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height })

  const rects = plan.steps.map((step): StepRects => {
    const parentKey = pathKey(step.parent)
    const found = findAnchor(scenes.registry(parentKey), step.anchor)
    let anchor = found ? rel(found.el.getBoundingClientRect()) : null
    const parentEl = scenes.el(parentKey)
    if (found && anchor && parentEl && visibleShare(anchor, viewport) < IN_VIEW) {
      parentEl.scrollTop += anchor.y + anchor.h / 2 - viewport.h / 2
      anchor = rel(found.el.getBoundingClientRect())
    }
    const content = findAnchor(scenes.registry(pathKey(step.child)), step.content)
    return {
      anchor: anchor && visibleShare(anchor, viewport) > 0 ? anchor : null,
      content: content ? rel(content.el.getBoundingClientRect()) : null
    }
  })
  return geometryOf(plan, rects, viewport, false)
}
