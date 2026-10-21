import { describe, expect, it } from 'vitest'
import type { StrataPath } from '../src/shared/strata'
import { framingToRestore, rememberFraming, type Framing } from '../src/strata/stage/framing'
import { pathKey, planFlight } from '../src/strata/stage/plan'
import type { ActivePlan } from '../src/strata/stage/stage-state'

const L0: StrataPath = {}
const M: StrataPath = { machine: 'm' }
const W: StrataPath = { machine: 'm', workspace: 'w' }
const A: StrataPath = { machine: 'm', workspace: 'w', agent: 'a' }

/**
 * The stage's take-off, minus the DOM: levels that mount start at scroll 0,
 * remembered framings are restored, then take-off may scroll a parent to bring
 * its anchor into view (`intoView`), then every flown level is remembered.
 * Returns the scroll each level of the flight has as the camera leaves.
 */
const fly = (
  world: { framing: Framing; scroll: Map<string, number> },
  from: StrataPath,
  to: StrataPath,
  intoView: Record<string, number> = {}
): Map<string, number> => {
  const plan = planFlight(from, to) as ActivePlan
  for (const p of plan.scenes) if (!world.scroll.has(pathKey(p))) world.scroll.set(pathKey(p), 0)
  world.framing = rememberFraming(world.framing, [[pathKey(from), world.scroll.get(pathKey(from)) ?? 0]])
  for (const [key, top] of framingToRestore(plan, world.framing)) world.scroll.set(key, top)
  for (const [key, top] of Object.entries(intoView)) world.scroll.set(key, top)
  world.framing = rememberFraming(
    world.framing,
    plan.scenes.map((p) => [pathKey(p), world.scroll.get(pathKey(p)) ?? 0])
  )
  const seen = new Map(plan.scenes.map((p) => [pathKey(p), world.scroll.get(pathKey(p)) ?? 0]))
  // Landing unmounts every level but the destination: a remounted level starts at 0 again.
  for (const p of plan.scenes) if (pathKey(p) !== pathKey(to)) world.scroll.delete(pathKey(p))
  return seen
}

describe('framing: Back restores every level exactly', () => {
  it('a dive and then the same number of outs returns every level to its own scroll position', () => {
    const world = { framing: new Map() as Framing, scroll: new Map([[pathKey(L0), 300]]) }
    // Dive from a scrolled level 0; take-off scrolls the machine's and the workspace's levels to their anchors.
    const dive = fly(world, L0, A, { [pathKey(M)]: 120, [pathKey(W)]: 480 })
    expect(dive.get(pathKey(L0))).toBe(300)

    const out1 = fly(world, A, W)
    expect(out1.get(pathKey(W))).toBe(480)
    const out2 = fly(world, W, M)
    expect(out2.get(pathKey(M))).toBe(120)
    const out3 = fly(world, M, L0)
    expect(out3.get(pathKey(L0))).toBe(300)
  })

  it('a level the user scrolled at rest keeps that, not its older flown framing', () => {
    const world = { framing: new Map() as Framing, scroll: new Map([[pathKey(W), 0]]) }
    fly(world, W, A, { [pathKey(W)]: 200 })
    fly(world, A, W)
    world.scroll.set(pathKey(W), 650) // the user scrolls the agents level
    fly(world, W, M)
    expect(fly(world, M, W).get(pathKey(W))).toBe(650)
  })

  it('a level never visited before starts at the top', () => {
    const plan = planFlight(L0, M) as ActivePlan
    expect(framingToRestore(plan, new Map([[pathKey(L0), 90]]))).toEqual([])
  })
})
