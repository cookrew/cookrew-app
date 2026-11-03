// Back restores the exact framing (motion.html §7): every level remembers the
// scroll it was flown with, the one the user left it at or the one take-off set
// to bring its anchor into view, and gets it back when the camera returns. Pure,
// so a dive followed by the same number of outs is testable without a DOM.
import { pathKey } from './plan'
import type { ActivePlan } from './stage-state'

/** scrollTop per level (pathKey). */
export type Framing = ReadonlyMap<string, number>

/** Scroll writes to make before measuring: every remembered level of the flight except the one we leave (it is on screen as it is). */
export const framingToRestore = (plan: ActivePlan, framing: Framing): Array<[key: string, top: number]> => {
  const from = pathKey(plan.from)
  return plan.scenes
    .map(pathKey)
    .filter((key) => key !== from && framing.has(key))
    .map((key) => [key, framing.get(key) as number])
}

/** After measuring: every level of the flight keeps the framing it was flown with. */
export const rememberFraming = (framing: Framing, flown: Array<[key: string, top: number]>): Framing => new Map([...framing, ...flown])
