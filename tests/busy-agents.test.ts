// THE ITEM PETS RE-RENDER WHEN WHO IS BUSY CHANGES, NOT ON EVERY ACTIVITY EVENT
// (perf, 2026-11-01: they read the whole activity map and rebuilt every
// item's JSX several times a second while any agent worked: 381 ms in 10 s).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { busyAgentsKey } from '../src/renderer/src/activity-thumb-store'
import type { TerminalActivity } from '../src/shared/turn'

const act = (phase: TerminalActivity['phase'], over: Partial<TerminalActivity> = {}) => ({ phase, updatedAt: 1, ...over }) as TerminalActivity

describe('busyAgentsKey', () => {
  it('lists the agents waiting on you first, then the thinking ones, each in the map order', () => {
    expect(busyAgentsKey({ a: act('thinking'), b: act('idle'), c: act('waiting'), d: act('thinking'), e: act('replied'), f: act('waiting') })).toBe('c f a d')
    expect(busyAgentsKey({})).toBe('')
  })

  it('is the same string while only the activity details change', () => {
    const before = busyAgentsKey({ a: act('thinking', { updatedAt: 1 }), b: act('waiting') })
    const after = busyAgentsKey({ a: act('thinking', { updatedAt: 2, title: 'new' } as Partial<TerminalActivity>), b: act('waiting') })
    expect(after).toBe(before)
  })
})

describe('the item pets', () => {
  it('read who is busy, not the whole activity map, and build their members when the column changes', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src/renderer/src/pets/ItemPets.tsx'), 'utf8')
    expect(src).not.toContain('useActivitiesSnapshot')
    expect(src).toContain('const busy = useBusyAgents()')
    expect(src).toContain('const moreMembers = useMemo(() => column.more.map(member), [column.more, member])')
  })
})
