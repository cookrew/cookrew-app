import { describe, expect, it } from 'vitest'
import {
  fleetTotals,
  mergeRows,
  radiusFor,
  readFleet,
  strideFor,
  towerHeight,
  type WorkspaceLike
} from '../src/renderer/src/world/fleet'
import type { BoardRow, BoardPhase } from '../src/shared/board'

const NOW = 1_700_000_000_000
const MIN = 60_000

function row(over: {
  id: string
  ws: string
  phase?: BoardPhase
  turns?: number
  agoMin?: number
}): BoardRow {
  return {
    terminalId: over.id,
    agent: { name: over.id, preset: 'Claude Code', role: null, orch: false },
    workspace: { id: over.ws, name: over.ws, active: false },
    cwd: '~',
    task: { title: null, summary: '', turnIndex: 0, startedAt: 0, endedAt: null },
    phase: over.phase ?? 'done',
    source: 'ledger',
    lastActivityAt: NOW - (over.agoMin ?? 10) * MIN,
    turnCount: over.turns ?? 1
  } as BoardRow
}
const ws = (id: string): WorkspaceLike => ({ id, name: id, icon: '🗂' })

describe('the avenue', () => {
  it('puts the workspace you are standing in at the front, whatever its clock', () => {
    // The active workspace is the one on screen behind this view. A map that
    // placed it behind you would be describing somewhere else.
    const places = readFleet(
      [row({ id: 'a', ws: 'old', agoMin: 10 }), row({ id: 'b', ws: 'live', agoMin: 9999 })],
      [ws('old'), ws('live')],
      'live',
      NOW
    )
    expect(places[0].id).toBe('live')
    expect(places[0].at.z).toBe(0)
    expect(places[1].at.z).toBeLessThan(0)
  })

  it('recedes by DORMANCY, so the gap in the road is the gap in your attention', () => {
    const tight = readFleet(
      [row({ id: 'a', ws: 'w1', agoMin: 1 }), row({ id: 'b', ws: 'w2', agoMin: 6 })],
      [ws('w1'), ws('w2')],
      'w1',
      NOW
    )
    const stale = readFleet(
      [row({ id: 'a', ws: 'w1', agoMin: 1 }), row({ id: 'b', ws: 'w2', agoMin: 60 * 24 * 14 })],
      [ws('w1'), ws('w2')],
      'w1',
      NOW
    )
    expect(Math.abs(stale[1].at.z)).toBeGreaterThan(Math.abs(tight[1].at.z) * 1.5)
  })

  it('fans the lanes out, because perspective piles a constant lane up', () => {
    const places = readFleet(
      Array.from({ length: 7 }, (_, i) => row({ id: `a${i}`, ws: `w${i}`, agoMin: i * 30 })),
      Array.from({ length: 7 }, (_, i) => ws(`w${i}`)),
      'w0',
      NOW
    )
    const near = Math.abs(places[1].at.x)
    const far = Math.abs(places[6].at.x)
    expect(far).toBeGreaterThan(near)
  })

  it('still gives an empty workspace an island — an empty place is information', () => {
    const places = readFleet([], [ws('quiet')], 'quiet', NOW)
    expect(places).toHaveLength(1)
    expect(places[0].agents).toHaveLength(0)
  })

  it('keeps a workspace the list forgot, if the board knows agents in it', () => {
    const places = readFleet([row({ id: 'a', ws: 'ghost' })], [], 'none', NOW)
    expect(places.map((p) => p.id)).toContain('ghost')
  })
})

describe('an island and its crew', () => {
  it('seats the agents that want you nearest the middle', () => {
    const places = readFleet(
      [
        row({ id: 'calm1', ws: 'w', phase: 'done' }),
        row({ id: 'calm2', ws: 'w', phase: 'done' }),
        row({ id: 'asks', ws: 'w', phase: 'waiting' }),
        row({ id: 'calm3', ws: 'w', phase: 'done' })
      ],
      [ws('w')],
      'w',
      NOW
    )
    const crew = places[0].agents
    const radius = (id: string): number => {
      const a = crew.find((x) => x.id === id)
      return a ? Math.hypot(a.at.x, a.at.z) : 99
    }
    for (const calm of ['calm1', 'calm2', 'calm3']) {
      expect(radius('asks')).toBeLessThan(radius(calm))
    }
  })

  it('keeps every tower on its island', () => {
    const places = readFleet(
      Array.from({ length: 30 }, (_, i) => row({ id: `a${i}`, ws: 'w' })),
      [ws('w')],
      'w',
      NOW
    )
    for (const agent of places[0].agents) {
      expect(Math.hypot(agent.at.x, agent.at.z)).toBeLessThanOrEqual(1.0001)
    }
  })

  it('sizes the island by the crew and the tower by the turns', () => {
    expect(radiusFor(40)).toBeGreaterThan(radiusFor(4))
    expect(towerHeight(300)).toBeGreaterThan(towerHeight(10))
    // Log, so a 300-turn agent does not leave the sky.
    expect(towerHeight(300)).toBeLessThan(towerHeight(10) * 3)
    expect(strideFor(7 * 24 * 3600_000)).toBeGreaterThan(strideFor(0))
  })

  it('counts the fleet the way the HUD reports it', () => {
    const places = readFleet(
      [
        row({ id: 'a', ws: 'w1', phase: 'waiting' }),
        row({ id: 'b', ws: 'w1', phase: 'working' }),
        row({ id: 'c', ws: 'w2', phase: 'done' })
      ],
      [ws('w1'), ws('w2')],
      'w1',
      NOW
    )
    expect(fleetTotals(places)).toEqual({ agents: 3, waiting: 1, working: 1, places: 2 })
  })
})

describe('the wide snapshot', () => {
  it('keeps a quiet agent when the live push only carries the last day', () => {
    // The board is a timeline and windows itself; the world is a map. A push
    // that no longer mentions last week's agent must not erase its island.
    const wide = [
      row({ id: 'fresh', ws: 'w1', agoMin: 5 }),
      row({ id: 'quiet', ws: 'w2', agoMin: 6 * 24 * 60 })
    ]
    const push = [row({ id: 'fresh', ws: 'w1', phase: 'waiting', agoMin: 1 })]
    const merged = mergeRows(wide, push)
    expect(merged.map((r) => r.terminalId).sort()).toEqual(['fresh', 'quiet'])
    // …and the push still corrects the row it does know about.
    expect(merged.find((r) => r.terminalId === 'fresh')?.phase).toBe('waiting')
  })

  it('orders by the clock, freshest first', () => {
    const merged = mergeRows(
      [row({ id: 'old', ws: 'w1', agoMin: 900 })],
      [row({ id: 'new', ws: 'w1', agoMin: 2 })]
    )
    expect(merged.map((r) => r.terminalId)).toEqual(['new', 'old'])
  })

  it('does not mutate what it was given', () => {
    const prev = [row({ id: 'a', ws: 'w1' })]
    const next = [row({ id: 'b', ws: 'w1' })]
    mergeRows(prev, next)
    expect(prev).toHaveLength(1)
    expect(next).toHaveLength(1)
  })
})
