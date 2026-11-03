import { describe, expect, it } from 'vitest'
import type { AnchorId, Rect, StrataPath } from '../src/shared/strata'
import { createRegistry, type AnchorRegistry } from '../src/strata/stage/anchors'
import { fitStep } from '../src/strata/stage/camera'
import { measureFlight, type SceneLookup } from '../src/strata/stage/measure'
import { pathKey, planFlight } from '../src/strata/stage/plan'
import type { ActivePlan } from '../src/strata/stage/stage-state'

// No jsdom: a scene is a scroll offset, an anchor a rect inside one scene that moves with its scroll.
const VIEW: Rect = { x: 0, y: 0, w: 1000, h: 800 }
const scene = () => ({ scrollTop: 0 })
const drawn = (host: { scrollTop: number }, r: Rect) => ({
  isConnected: true,
  getBoundingClientRect: () => ({ left: r.x, top: r.y - host.scrollTop, width: r.w, height: r.h })
})
const root = { getBoundingClientRect: () => ({ left: 0, top: 0, width: VIEW.w, height: VIEW.h }) } as unknown as HTMLElement

describe('measure', () => {
  it('a dive scrolls every level before it reads a rect: a later anchor brought into view does not break an earlier content rect', () => {
    const top: StrataPath = {}
    const M: StrataPath = { machine: 'm' }
    const W: StrataPath = { machine: 'm', workspace: 'w' }
    const plan = planFlight(top, W) as ActivePlan
    expect(plan.steps).toHaveLength(2)
    const [s0, s1] = plan.steps
    const levels = new Map([top, M, W].map((p) => [pathKey(p), scene()]))
    const registries = new Map<string, AnchorRegistry>([top, M, W].map((p) => [pathKey(p), createRegistry()]))
    const put = (at: StrataPath, id: AnchorId, r: Rect) => registries.get(pathKey(at))!.set(id, drawn(levels.get(pathKey(at))!, r) as unknown as Element)

    put(top, s0.anchor[s0.anchor.length - 1], { x: 100, y: 100, w: 200, h: 160 })
    // Level M: the machine's region (step 0's content) and, far below the fold, the workspace (step 1's anchor).
    put(M, s0.content[0], { x: 0, y: 0, w: 1000, h: 800 })
    put(M, s1.anchor[0], { x: 300, y: 1800, w: 300, h: 200 })
    put(W, s1.content[0], { x: 0, y: 0, w: 1000, h: 800 })

    const lookup: SceneLookup = {
      el: (k) => levels.get(k) as unknown as HTMLElement | undefined,
      registry: (k) => registries.get(k),
      framing: { current: new Map() }
    }
    const geometry = measureFlight(root, plan, lookup, false)
    if (geometry.kind !== 'zoom') throw new Error(`expected a zoom, got ${geometry.kind}`)

    const scrolled = levels.get(pathKey(M))!.scrollTop
    expect(scrolled).toBe(1800 + 100 - 400)
    // Step 0 lands on the machine's region where it is after that scroll, not where it was before.
    expect(geometry.steps[0].fit).toEqual(fitStep({ x: 100, y: 100, w: 200, h: 160 }, { x: 0, y: -scrolled, w: 1000, h: 800 }))
    expect(geometry.steps[1].fit).toEqual(fitStep({ x: 300, y: 1800 - scrolled, w: 300, h: 200 }, VIEW))
  })
})
