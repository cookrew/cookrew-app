import { describe, expect, it } from 'vitest'
import {
  GUTTER,
  PITCH,
  orderCards,
  planGrid,
  roundedPath,
  routeCables,
  slotCentre,
  type AnatomyClusterInput
} from '../src/renderer/src/anatomy/layout'
import { CARD_HEIGHT, CELL } from '../src/renderer/src/anatomy/cards'

const agent = (id: string): AnatomyClusterInput => ({ id, kind: 'terminal', owner: null })
const note = (id: string, owner: string | null): AnatomyClusterInput => ({
  id,
  kind: 'note',
  owner
})

describe('planGrid', () => {
  it('fills the stage instead of laying one long row', () => {
    // The first scorer matched the floor's ASPECT to the screen's, and at the
    // default azimuth that aspect is the same for every column count — so the
    // tie broke on wasted slots and 14 cards became a 14x1 strip across a
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
    const grid = planGrid(40, 390 / 739, 'portrait')
    expect(grid.rows).toBeGreaterThanOrEqual(grid.cols)
    expect(grid.azimuth).toBeGreaterThan(45)
  })

  it('keeps the kit camera when the stage does not demand otherwise', () => {
    const grid = planGrid(36, 16 / 9, 'landscape')
    expect(grid.azimuth).toBe(45)
  })

  it('always has room for every card', () => {
    for (const n of [1, 2, 7, 33, 250]) {
      const grid = planGrid(n, 1440 / 795, 'landscape')
      expect(grid.cols * grid.rows).toBeGreaterThanOrEqual(n)
    }
  })
})

describe('card heights', () => {
  it('stay under the height that would hide the row behind', () => {
    // h*cos(e) is how far a card climbs the screen; pitch*sin(a)*sin(e) is how
    // far the row behind it already sits. Taller than the ratio of those and a
    // card covers its neighbour's nameplate, which is what 17 used to do.
    const worst = Math.min(
      ...[24, 30, 38, 46, 54].flatMap((elevation) =>
        [45, 54, 63, 72, 80, 86].map((azimuth) => {
          const a = (azimuth * Math.PI) / 180
          const e = (elevation * Math.PI) / 180
          return PITCH * Math.sin(a) * Math.tan(e)
        })
      )
    )
    expect(CARD_HEIGHT.terminal).toBeLessThan(worst)
    expect(CARD_HEIGHT.terminal).toBeGreaterThan(CARD_HEIGHT.browser)
    expect(CARD_HEIGHT.browser).toBeGreaterThan(CARD_HEIGHT.note)
  })

  it('leaves a real aisle between slots for the cables', () => {
    expect(PITCH).toBe(CELL + GUTTER)
    expect(GUTTER).toBeGreaterThan(8)
  })
})

describe('orderCards', () => {
  it('keeps an agent and the cards it owns together', () => {
    const order = orderCards(
      [agent('a'), agent('b'), note('n1', 'a'), note('n2', 'b'), note('n3', 'a')],
      8
    )
    const at = (id: string): number => order.indexOf(id)
    expect(at('n1')).toBe(at('a') + 1)
    expect(at('n3')).toBe(at('a') + 2)
    expect(at('n2')).toBe(at('b') + 1)
  })

  it('starts a new row rather than splitting a block that would fit on one', () => {
    // Four columns, a block of three already down, then a block of three: the
    // second must not wrap, so one slot is left empty on purpose.
    const order = orderCards(
      [
        agent('a'),
        note('a1', 'a'),
        note('a2', 'a'),
        agent('b'),
        note('b1', 'b'),
        note('b2', 'b')
      ],
      4
    )
    expect(order[3]).toBe('')
    expect(order.slice(4, 7)).toEqual(['b', 'b1', 'b2'])
  })

  it('parks cards wired to no agent in their own block', () => {
    const order = orderCards([agent('a'), note('loose', null), note('a1', 'a')], 8)
    expect(order.filter((id) => id !== '')).toHaveLength(3)
    expect(order.indexOf('loose')).toBeGreaterThan(order.indexOf('a1'))
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
    // Every cable leaving the same slot used to start at the same corner
    // point, and six of them met in a single knot there.
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

  it('runs in the aisle, never across a card', () => {
    const cables = routeCables([['a', 'd']], indexOf, grid)
    for (const [x, y] of cables[0].points) {
      // Distance from the nearest slot centre, on the axis that is not the
      // cable's own run, has to clear the card's footprint.
      const near = (v: number): number => {
        const k = Math.round(v / PITCH - 0.5)
        return Math.abs(v - (k + 0.5) * PITCH)
      }
      expect(Math.max(near(x), near(y))).toBeGreaterThan(CELL / 2 - 0.01)
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
