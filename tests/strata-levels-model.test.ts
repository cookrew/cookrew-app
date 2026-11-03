import { describe, expect, it } from 'vitest'
import type { Rect, StrataMachine } from '../src/shared/strata'
import { syntheticFleet } from '../src/strata/fixture/synthetic'
import { buildLevelModel, levelArea } from '../src/strata/levels/model'
import { colorFigures } from '../src/strata/figures'
import { MIN_TARGET, underTarget } from '../src/strata/levels/layout'
import type { FigureKit } from '../src/strata/seams'
import { standInFigures } from '../src/strata/stand-in/figures'

const fleet: StrataMachine[] = syntheticFleet(1_000_000).map((m) => ({
  ...m,
  base: `/m/${m.id}/`,
  link: m.online ? 'live' : 'offline',
  stale: !m.online && m.levels !== null
}))
const desktop: Rect = { x: 0, y: 0, w: 1440, h: 848 }
const phone: Rect = { x: 0, y: 0, w: 390, h: 844 }

/** Records what the levels ask the kit for: a phone must ask for exactly what a desktop does. */
const asked: Array<Parameters<FigureKit['container']>[0]> = []
const recordingKit: FigureKit = {
  ...colorFigures,
  container: (input) => {
    asked.push(input)
    return colorFigures.container(input)
  }
}
const askedOn = (path: Parameters<typeof buildLevelModel>[0], viewport: Rect) => {
  asked.length = 0
  buildLevelModel(path, fleet, viewport, recordingKit)
  return [...asked]
}
/** The fleet with studio's first workspace cut to its first `agents` (it has 48). */
const withAgents = (agents: number): StrataMachine[] =>
  fleet.map((m) =>
    m.id !== 'syn-studio' || !m.levels
      ? m
      : {
          ...m,
          levels: {
            ...m.levels,
            workspaces: m.levels.workspaces.map((w, i) => (i === 0 ? { ...w, agents: w.agents.slice(0, agents) } : w))
          }
        }
  )
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01

describe('the level model', () => {
  it('is pure: same path, fleet and viewport give the same model', () => {
    for (const path of [{}, { machine: 'syn-studio' }, { machine: 'syn-studio', workspace: 'syn-studio-w0' }]) {
      expect(buildLevelModel(path, fleet, desktop, standInFigures)).toEqual(buildLevelModel(path, fleet, desktop, standInFigures))
    }
  })

  it("draws L0's miniature of a machine exactly as its L1, scaled once", () => {
    const l0 = buildLevelModel({}, fleet, desktop, standInFigures)
    const l1 = buildLevelModel({ machine: 'syn-studio' }, fleet, desktop, standInFigures)
    if (l0.level !== 'machines' || l1.level !== 'workspaces') throw new Error('wrong levels')
    const mini = l0.minis.get('syn-studio')!
    const { s, dx, dy } = mini.transform
    l1.seats.forEach((seat, i) => {
      const m = mini.seats[i]
      expect(m.key).toBe(seat.key)
      expect(m.rect.x).toBeCloseTo(seat.rect.x * s + dx, 6)
      expect(m.rect.y).toBeCloseTo(seat.rect.y * s + dy, 6)
      expect(m.rect.w).toBeCloseTo(seat.rect.w * s, 6)
    })
  })

  it('keeps agents in creation order at every level', () => {
    const l2 = buildLevelModel({ machine: 'syn-studio', workspace: 'syn-studio-w0' }, fleet, desktop, standInFigures)
    const created = fleet[0].levels!.workspaces[0].agents.map((a) => a.id)
    expect(l2.items.map((it) => it.target.agent)).toEqual(created)
  })

  it('asks the kit for the same table on a phone as on a desktop', () => {
    for (const path of [{ machine: 'syn-studio' }, { machine: 'syn-studio', workspace: 'syn-studio-w0' }]) {
      const onPhone = askedOn(path, phone)
      expect(onPhone.length).toBeGreaterThan(0)
      expect(onPhone).toEqual(askedOn(path, desktop))
    }
  })

  it('measures L2 targets on the hit: a desktop table clears the pointer target, a phone one picks first', () => {
    const hitW = (agents: number, viewport: Rect) =>
      buildLevelModel({ machine: 'syn-studio', workspace: 'syn-studio-w0' }, withAgents(agents), viewport, colorFigures).seats[0].hit.w
    for (const agents of [2, 12, 48]) {
      expect(underTarget(hitW(agents, desktop), false), `desktop ${agents}`).toBe(false)
      // The same table, smaller: its seat pitch is under a finger, so a first tap picks.
      expect(underTarget(hitW(agents, phone), true), `phone ${agents}`).toBe(true)
    }
    // Longer tables shrink, the same shape.
    expect(hitW(24, phone)).toBeLessThan(hitW(12, phone))
    expect(hitW(48, phone)).toBeLessThan(hitW(24, phone))
  })

  it('measures L1 targets on the drawn ball, not the seat art around it', () => {
    const l1 = buildLevelModel({ machine: 'syn-studio' }, fleet, desktop, colorFigures)
    const [seat] = l1.seats
    expect(seat.ball.w).toBeLessThan(seat.rect.w * 0.6)
    expect(underTarget(seat.ball.w, false)).toBe(seat.ball.w < MIN_TARGET.pointer)
  })

  it('grows L2 hits to the pitch of the drawn table without ever overlapping, phone and desktop, 48 agents included', () => {
    for (const viewport of [phone, desktop]) {
      const l2 = buildLevelModel({ machine: 'syn-studio', workspace: 'syn-studio-w0' }, fleet, viewport, colorFigures)
      expect(l2.seats).toHaveLength(48)
      l2.seats.forEach((a, i) => {
        expect(a.hit.w).toBeGreaterThanOrEqual(a.ball.w)
        expect(a.hit.x + a.hit.w / 2).toBeCloseTo(a.ball.x + a.ball.w / 2, 6)
        l2.seats.slice(i + 1).forEach((b) => expect(overlap(a.hit, b.hit), `${a.key} ${b.key}`).toBe(false))
      })
    }
  })

  it('hit targets never overlap', () => {
    const l2 = buildLevelModel({ machine: 'syn-studio', workspace: 'syn-studio-w0' }, fleet, desktop, standInFigures)
    const [a, b] = l2.seats
    expect(a.hit.x + a.hit.w).toBeLessThanOrEqual(b.hit.x + 0.01)
  })

  it('keeps every level inside the same inset, so stage flights land on it', () => {
    const area = levelArea(desktop)
    const l1 = buildLevelModel({ machine: 'syn-studio' }, fleet, desktop, standInFigures)
    l1.items.forEach((it) => {
      expect(it.rect.x).toBeGreaterThanOrEqual(area.x - 0.01)
      expect(it.rect.x + it.rect.w).toBeLessThanOrEqual(area.x + area.w + 0.01)
    })
  })

  it('a machine never reached has no workspaces to lay out, and the terminal level has no items', () => {
    expect(buildLevelModel({ machine: 'syn-vm' }, fleet, desktop, standInFigures).items).toEqual([])
    const t = buildLevelModel({ machine: 'syn-studio', workspace: 'syn-studio-w0', agent: 'syn-studio-w0-a1' }, fleet, desktop, standInFigures)
    expect(t.level).toBe('terminal')
    expect(t.items).toEqual([])
  })
})
