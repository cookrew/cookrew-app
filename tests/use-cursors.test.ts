// THE AGENTS' CURSORS (renderer/use-cursors.ts): one per agent per card, moved
// by pointed actions, kept by pointless ones, sent home when quiet.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/api', () => ({ cookrew: () => ({}) }))
const { admitUse, ageCursors, CURSOR_IDLE_MS, CURSOR_RETURN_MS, HOME } = await import('../src/renderer/src/use-cursors')

const sig = (agent: string, verb: string, point: { x: number; y: number } | null, at: number) => ({
  agent,
  card: 'c',
  use: 'phone' as const,
  verb,
  point,
  viewport: point ? { width: 400, height: 800 } : null,
  at
})

describe('admitUse / ageCursors', () => {
  it('a pointed action places the cursor; a key keeps it where it was', () => {
    let list = admitUse([], sig('a', 'tap', { x: 100, y: 400 }, 0))
    expect(list).toEqual([{ agent: 'a', at: { x: 0.25, y: 0.5 }, verb: 'tap', actedAt: 0, returningSince: null }])
    list = admitUse(list, sig('a', 'key', null, 10))
    expect(list[0]).toMatchObject({ at: { x: 0.25, y: 0.5 }, verb: 'key', actedAt: 10 })
  })

  it('two agents on one card are two cursors', () => {
    const list = admitUse(admitUse([], sig('a', 'tap', { x: 0, y: 0 }, 0)), sig('b', 'tap', { x: 400, y: 800 }, 0))
    expect(list.map((c) => [c.agent, c.at])).toEqual([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 1, y: 1 }]
    ])
  })

  it('quiet long enough: heads home, then is gone; nothing changed is the same array', () => {
    const list = admitUse([], sig('a', 'tap', { x: 100, y: 100 }, 0))
    expect(ageCursors(list, CURSOR_IDLE_MS - 1)).toBe(list)
    const home = ageCursors(list, CURSOR_IDLE_MS)
    expect(home[0]).toMatchObject({ at: HOME, returningSince: CURSOR_IDLE_MS })
    expect(ageCursors(home, CURSOR_IDLE_MS + CURSOR_RETURN_MS)).toEqual([])
  })

  it('an action while heading home brings the cursor back out', () => {
    const home = ageCursors(admitUse([], sig('a', 'tap', { x: 100, y: 100 }, 0)), CURSOR_IDLE_MS)
    const back = admitUse(home, sig('a', 'type', null, CURSOR_IDLE_MS + 10))
    expect(back[0]).toMatchObject({ returningSince: null, at: { x: 0.5, y: 0.5 } })
  })
})
