// Where keyboard focus lands after a flight (motion.html §8). Once, after
// landing, never during; never stolen from an input outside the stage.
import { levelOf, type StrataPath } from '../../shared/strata'
import { findAnchor, type AnchorRegistry } from './anchors'
import type { ActivePlan } from './stage-state'

const FOCUSABLE = 'a[href], button, input, select, textarea, iframe, [tabindex]'

const focusableFrom = (el: Element | null | undefined): HTMLElement | null => {
  const hit = el?.closest(FOCUSABLE)
  return hit instanceof HTMLElement ? hit : null
}

export const focusAfterLanding = (root: HTMLElement, sceneEl: HTMLElement, registry: AnchorRegistry | undefined, rest: StrataPath, plan: ActivePlan | null): void => {
  const active = document.activeElement
  if (active && active !== document.body && !root.contains(active)) return
  let target: HTMLElement | null = null
  // Out: back onto the item we came out of, so Enter goes straight back in.
  if (plan && plan.dir < 0 && plan.kind !== 'hop') target = focusableFrom(findAnchor(registry, plan.steps[0].anchor)?.el)
  if (!target && levelOf(rest) === 'terminal') target = focusableFrom(findAnchor(registry, ['terminal'])?.el)
  if (!target) target = focusableFrom(sceneEl.querySelector('[data-stage-focus]'))
  ;(target ?? sceneEl).focus({ preventScroll: true })
}
