import { describe, expect, it } from 'vitest'
import {
  GUTTER,
  PITCH,
  orderAgents,
  planGrid,
  roundedPath,
  routeCables,
  slotCentre
} from '../src/renderer/src/anatomy/layout'
import { STATION_CELL } from '../src/renderer/src/anatomy/station'

const AZIMUTHS = [45, 78]
const ELEVATIONS = [30, 38]

describe('planGrid', () => {
  it('fills the stage instead of laying one long row', () => {
    // The first scorer matched the floor's ASPECT to the screen's, and with the
    // camera fixed that aspect is the same for every column count — so the tie
    // broke on wasted slots, and fourteen units became a 14x1 strip across a
    // 1440px stage with the whole screen empty around it.
    const grid = planGrid(14, 1440 / 795, 'landscape')
    expect(grid.rows).toBeGreaterThan(1)
    expect(grid.cols).toBeLessThan(14)
    expect(grid.cols * grid.rows).toBeGreaterThanOrEqual(14)
  })

  it('turns the camera for a phone held upright, which reshaping cannot do', () => {
    // At azimuth 45 the floor projects to a diamond whose aspect is
    // 1/sin(elevation) WHATEVER the grid is, so a portrait picture is only
    // reachable by swinging the camera round.
    const grid = planGrid(33, 390 / 739, 'portrait')
    expect(grid.rows).toBeGreaterThanOrEqual(grid.cols)
    expect(grid.azimuth).toBeGreaterThan(45)
  })

  it('keeps the kit camera in landscape', () => {
    expect(planGrid(33, 16 / 9, 'landscape').azimuth).toBe(45)
  })

  it('always has room for every agent', () => {
    for (const n of [1, 2, 7, 33, 120]) {
      const grid = planGrid(n, 1440 / 795, 'landscape')
      expect(grid.cols * grid.rows).toBeGreaterThanOrEqual(n)
    }
  })
})

describe('the station in its slot', () => {
  it('stands under the height that would hide the row behind it', () => {
    // h*cos(e) is how far a solid climbs the screen; pitch*sin(a)*sin(e) is how
    // far the row behind already sits. Taller than the ratio of those and a
    // station covers its neighbour. The MAST is deliberately exempt: a raised
    // flag breaking the plane is the whole point of it.
    const ceiling = Math.min(
      ...ELEVATIONS.flatMap((elevation) =>
        AZIMUTHS.map((azimuth) => {
          const a = (azimuth * Math.PI) / 180
          const e = (elevation * Math.PI) / 180
          return PITCH * Math.sin(a) * Math.tan(e)
        })
      )
    )
    const plinthAndDesk = 1.6 + 14
    expect(plinthAndDesk).toBeLessThan(ceiling)
  })

  it('leaves a real aisle between slots for the cables', () => {
    expect(PITCH).toBe(STATION_CELL + GUTTER)
    expect(GUTTER).toBeGreaterThan(8)
  })
})

describe('orderAgents', () => {
  const link = (a: string, b: string): readonly [string, string] => [a, b] as const
  const cell = (slot: number, cols: number): [number, number] => [slot % cols, Math.floor(slot / cols)]
  const far = (s: number, t: number, cols: number): number => {
    const [a, b] = cell(s, cols)
    const [c, d] = cell(t, cols)
    return Math.abs(a - c) + Math.abs(b - d)
  }

  it('places every agent exactly once', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const out = orderAgents(ids, [], 3, 2)
    expect(out).toHaveLength(6)
    expect(out.filter((id) => id !== '').sort()).toEqual([...ids].sort())
  })

  it('sits a hub next to everyone it talks to', () => {
    // The whole reason to order at all: short cables are the difference
    // between a diagram and a hairball.
    const ids = ['hub', 'p1', 'p2', 'p3', 'p4']
    const links = [link('hub', 'p1'), link('hub', 'p2'), link('hub', 'p3'), link('hub', 'p4')]
    const out = orderAgents(ids, links, 3, 3)
    const at = (id: string): number => out.indexOf(id)
    for (const peer of ['p1', 'p2', 'p3', 'p4']) {
      expect(far(at('hub'), at(peer), 3)).toBe(1)
    }
  })

  it('is the same room every time, so a status change never shuffles it', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const links = [link('a', 'b'), link('b', 'c'), link('e', 'f')]
    expect(orderAgents(ids, links, 3, 2)).toEqual(orderAgents(ids, links, 3, 2))
  })

  it('ignores a link to something that is not on the board', () => {
    const out = orderAgents(['a', 'b'], [link('a', 'ghost')], 2, 1)
    expect(out.filter((id) => id !== '').sort()).toEqual(['a', 'b'])
  })
})

describe('routeCables', () => {
  const grid = { cols: 4, rows: 4, azimuth: 45, elevation: 30 }
  const index = new Map([
    ['a', 0],
    ['b', 3],
    ['c', 8],
    ['d', 9]
  ])
  const indexOf = (id: string): number | undefined => index.get(id)

  it('gives every link its own polyline', () => {
    const cables = routeCables(
      [
        ['a', 'b'],
        ['a', 'c'],
        ['c', 'd']
      ],
      indexOf,
      grid
    )
    expect(cables).toHaveLength(3)
    for (const cable of cables) expect(cable.points.length).toBeGreaterThanOrEqual(2)
  })

  it('gives each cable its own port, so a bundle does not knot at one corner', () => {
    const cables = routeCables(
      [
        ['a', 'b'],
        ['a', 'c'],
        ['a', 'd']
      ],
      indexOf,
      grid
    )
    const starts = cables.map((c) => c.points[0].join(','))
    expect(new Set(starts).size).toBe(3)
  })

  it('drops a link whose end is not on the board', () => {
    expect(routeCables([['a', 'gone']], indexOf, grid)).toHaveLength(0)
    expect(routeCables([['a', 'a']], indexOf, grid)).toHaveLength(0)
  })

  it('runs in the aisle, never across a station', () => {
    const cables = routeCables([['a', 'd']], indexOf, grid)
    for (const [x, y] of cables[0].points) {
      const near = (v: number): number => {
        const k = Math.round(v / PITCH - 0.5)
        return Math.abs(v - (k + 0.5) * PITCH)
      }
      expect(Math.max(near(x), near(y))).toBeGreaterThan(STATION_CELL / 2 - 0.01)
    }
  })
})

describe('slotCentre', () => {
  it('walks in reading order', () => {
    const grid = { cols: 3, rows: 2, azimuth: 45, elevation: 30 }
    expect(slotCentre(0, grid)).toEqual({ x: PITCH * 0.5, y: PITCH * 0.5 })
    expect(slotCentre(2, grid)).toEqual({ x: PITCH * 2.5, y: PITCH * 0.5 })
    expect(slotCentre(3, grid)).toEqual({ x: PITCH * 0.5, y: PITCH * 1.5 })
  })
})

describe('roundedPath', () => {
  it('rounds the corners and keeps both ends', () => {
    const d = roundedPath(
      [
        [0, 0],
        [100, 0],
        [100, 100]
      ],
      10
    )
    expect(d.startsWith('M0.0 0.0')).toBe(true)
    expect(d).toContain('Q')
    expect(d.endsWith('L100.0 100.0')).toBe(true)
  })

  it('degrades to a plain line and to nothing', () => {
    expect(roundedPath([], 6)).toBe('')
    expect(
      roundedPath(
        [
          [1, 2],
          [3, 4]
        ],
        6
      )
    ).not.toContain('Q')
  })
})
