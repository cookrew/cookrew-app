// Where keyboard focus lands after a flight (motion.html §8). Once, after
// landing, never during; never stolen from an input outside the stage.
import { levelOf, type StrataPath } from '../../shared/strata'
import { findAnchor, type AnchorRegistry } from './anchors'
import type { ActivePlan } from './stage-state'

const FOCUSABLE = 'a[href], button, input, select, textarea, iframe, [tabindex]'

/**
 * The focusable an anchor stands for: itself or its nearest focusable ancestor, else the first one
 * inside it. Never the scene: its tabIndex -1 matches the selector, and it is only the last resort.
 */
const focusableIn = (sceneEl: HTMLElement, el: Element | null | undefined): HTMLElement | null => {
  if (!el) return null
  const inside = (hit: Element | null): hit is HTMLElement => hit instanceof HTMLElement && hit !== sceneEl && sceneEl.contains(hit)
  const up = el.closest(FOCUSABLE)
  if (inside(up)) return up
  const down = el.querySelector(FOCUSABLE)
  return inside(down) ? down : null
}

export const focusAfterLanding = (root: HTMLElement, sceneEl: HTMLElement, registry: AnchorRegistry | undefined, rest: StrataPath, plan: ActivePlan | null): void => {
  const active = document.activeElement
  if (active && active !== document.body && !root.contains(active)) return
  let target: HTMLElement | null = null
  // Out: back onto the item we came out of (the step's own item before a machine's portal), so Enter goes straight back in.
  if (plan && plan.dir < 0 && plan.kind !== 'hop') target = focusableIn(sceneEl, findAnchor(registry, [...plan.steps[0].anchor].reverse())?.el)
  if (!target && levelOf(rest) === 'terminal') target = focusableIn(sceneEl, findAnchor(registry, ['terminal'])?.el)
  if (!target) target = focusableIn(sceneEl, sceneEl.querySelector('[data-stage-focus]'))
  ;(target ?? sceneEl).focus({ preventScroll: true })
}
