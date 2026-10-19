import { describe, expect, it } from 'vitest'
import { dockDistance, flightMs, planDock, zoomPath } from '../src/renderer/src/world/dock'
import type { WorldPlace } from '../src/renderer/src/world/fleet'

const place = (id: string, radius: number): WorldPlace =>
  ({
    id,
    name: id,
    icon: '🗂',
    active: false,
    agents: [],
    waiting: 0,
    working: 0,
    lastActivityAt: 0,
    radius,
    at: { x: 0, y: 0, z: 0 }
  }) as WorldPlace

describe('the dock', () => {
  it('shapes the grid like the screen and keeps reading order', () => {
    const places = Array.from({ length: 10 }, (_, i) => place(`w${i}`, 40))
    const plan = planDock(places, 1.6)
    expect(plan.cols).toBe(4)
    expect(plan.rows).toBe(3)
    expect(plan.tiles[0]).toMatchObject({ id: 'w0', col: 0, row: 0 })
    expect(plan.tiles[4]).toMatchObject({ id: 'w4', col: 0, row: 1 })
    // The first row is the FAR one (-z), so it reads at the top of the screen.
    expect(plan.tiles[0].at.z).toBeLessThan(plan.tiles[4].at.z)
  })

  it('never lets two islands touch, whatever their sizes', () => {
    const places = [place('a', 30), place('b', 90), place('c', 45), place('d', 60)]
    const plan = planDock(places, 1.4)
    const big = Math.max(...places.map((p) => p.radius))
    for (let i = 0; i < plan.tiles.length; i++) {
      for (let j = i + 1; j < plan.tiles.length; j++) {
        const a = plan.tiles[i].at
        const b = plan.tiles[j].at
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(big * 2)
      }
    }
  })

  it('centres the grid on the origin', () => {
    const plan = planDock(Array.from({ length: 6 }, (_, i) => place(`w${i}`, 40)), 1.5)
    const cx = plan.tiles.reduce((s, t) => s + t.at.x, 0) / plan.tiles.length
    const cz = plan.tiles.reduce((s, t) => s + t.at.z, 0) / plan.tiles.length
    expect(Math.abs(cx)).toBeLessThan(1e-9)
    expect(Math.abs(cz)).toBeLessThan(1e-9)
  })

  it('stands the camera further back for a wider dock', () => {
    const small = planDock([place('a', 40)], 1.6)
    const wide = planDock(Array.from({ length: 12 }, (_, i) => place(`w${i}`, 40)), 1.6)
    expect(dockDistance(wide, 1.6, 52, 0.9)).toBeGreaterThan(dockDistance(small, 1.6, 52, 0.9))
    expect(planDock([], 1.6).tiles).toEqual([])
  })
})

describe('the flight', () => {
  it('starts and ends where it was told', () => {
    const path = zoomPath(500, 900, 180)
    expect(path.at(0).u).toBeCloseTo(0, 6)
    expect(path.at(0).w).toBeCloseTo(900, 6)
    expect(path.at(1).u).toBeCloseTo(500, 6)
    expect(path.at(1).w).toBeCloseTo(180, 6)
  })

  it('pulls out before it comes in when the pan is long', () => {
    // The van Wijk arc: a long pan between two close views bulges wider than
    // either end, so the ground slides by instead of smearing.
    const path = zoomPath(1200, 200, 200)
    expect(path.at(0.5).w).toBeGreaterThan(200)
  })

  it('is a plain exponential when nothing pans', () => {
    const path = zoomPath(0, 800, 200)
    expect(path.at(0.5).u).toBe(0)
    expect(path.at(0.5).w).toBeCloseTo(400, 6)
  })

  it('gives a long flight more time, within the window', () => {
    const hop = zoomPath(120, 700, 220)
    const trek = zoomPath(1400, 700, 220)
    expect(flightMs(trek.S)).toBeGreaterThan(flightMs(hop.S))
    expect(flightMs(hop.S)).toBeGreaterThanOrEqual(380)
    expect(flightMs(trek.S)).toBeLessThanOrEqual(900)
  })
})
