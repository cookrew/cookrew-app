import { describe, expect, it } from 'vitest'
import type { Rect, StrataMachine } from '../src/shared/strata'
import { syntheticFleet } from '../src/strata/fixture/synthetic'
import { buildLevelModel, levelArea } from '../src/strata/levels/model'
import { MIN_TARGET, PHONE_COLUMNS } from '../src/strata/levels/layout'
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

/** The stand-in ignores `columns`; Gouache honours it. This kit lays seats out the stand-in's way, in `columns` columns. */
const asked: Array<number | undefined> = []
const columnsKit: FigureKit = {
  ...standInFigures,
  container: ({ name, slots, columns }) => {
    asked.push(columns)
    const cols = Math.min(columns ?? 8, Math.max(1, slots))
    const base = standInFigures.container({ name, slots: Math.min(slots, cols) })
    const rows = Math.max(1, Math.ceil(slots / cols))
    const [w, h] = [cols * 40 + 24, rows * 40 + 56]
    const seats = Object.fromEntries(Array.from({ length: slots }, (_, i) => [`slot:${i}`, { x: 16 + (i % cols) * 40, y: 36 + Math.floor(i / cols) * 40, w: 32, h: 32 }]))
    return { ...base, viewBox: { x: 0, y: 0, w, h }, anchors: { label: { x: 12, y: 8, w: w - 24, h: 20 }, ...seats } }
  }
}

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

  it('asks the kit for phone columns, and only on a phone', () => {
    asked.length = 0
    buildLevelModel({ machine: 'syn-studio', workspace: 'syn-studio-w0' }, fleet, phone, columnsKit)
    expect(asked).toEqual([PHONE_COLUMNS])
    asked.length = 0
    buildLevelModel({ machine: 'syn-studio', workspace: 'syn-studio-w0' }, fleet, desktop, columnsKit)
    expect(asked).toEqual([undefined])
  })

  it('phone columns DRAW every L2 avatar at a touch target with the normal inset, 48 agents included', () => {
    const l2 = buildLevelModel({ machine: 'syn-studio', workspace: 'syn-studio-w0' }, fleet, phone, columnsKit)
    expect(l2.seats).toHaveLength(48)
    l2.seats.forEach((seat) => expect(seat.rect.w).toBeGreaterThanOrEqual(MIN_TARGET.touch))
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
