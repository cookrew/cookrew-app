// SPOKEN REPLIES FOR THE OTHER AGENTS (owner, 2026-11-03): only the box's
// agent was ever heard; the owner chose "just announce, don't read" for the
// rest: their name when they finish or need you, never their reply.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalActivity, TurnPhase } from '../src/shared/turn'
import { KeyedStore } from '../src/renderer/src/keyed-store'
import { EMPTY_CHIME_MEMORY, MIN_WORK_MS, stepChimes } from '../src/renderer/src/status-chime'
import { announcementsFor, installAnnouncer } from '../src/renderer/src/prompt/announce'

const act = (terminalId: string, phase: TurnPhase): TerminalActivity => ({ terminalId, agent: true, phase }) as TerminalActivity
const NAMES: Record<string, string> = { a: 'Gauge', b: 'Forge', c: '按钮助手' }
const nameOf = (id: string): string | undefined => NAMES[id]

describe('which agent rang', () => {
  it('each ring names its agent', () => {
    let memory = stepChimes(EMPTY_CHIME_MEMORY, { a: act('a', 'thinking'), b: act('b', 'thinking') }, 0).memory
    const step = stepChimes(memory, { a: act('a', 'replied'), b: act('b', 'waiting') }, MIN_WORK_MS)
    memory = step.memory
    expect(step.rings).toEqual([{ id: 'a', kind: 'done' }, { id: 'b', kind: 'waiting' }])
    expect(step.chimes).toEqual(['done', 'waiting'])
  })
})

describe('what is said', () => {
  it('the name and what happened, for every agent but the box’s', () => {
    const rings = [{ id: 'a', kind: 'done' as const }, { id: 'b', kind: 'waiting' as const }, { id: 'c', kind: 'done' as const }]
    expect(announcementsFor(rings, 'a', nameOf)).toEqual(['Forge 需要你', '按钮助手 完成了'])
    expect(announcementsFor(rings, null, nameOf)).toEqual(['Gauge 完成了', 'Forge 需要你', '按钮助手 完成了'])
  })
  it('an agent with no name says nothing', () => {
    expect(announcementsFor([{ id: 'zz', kind: 'done' }], null, nameOf)).toEqual([])
  })
})

describe('the announcer', () => {
  afterEach(() => vi.useRealTimers())

  const setup = (on: { value: boolean }, box: string | null) => {
    vi.useFakeTimers()
    const store = new KeyedStore<TerminalActivity>()
    store.set('a', act('a', 'thinking'))
    store.set('b', act('b', 'thinking'))
    const said: string[] = []
    const off = installAnnouncer({ store, isOn: () => on.value, boxAgentId: () => box, nameOf, say: (l) => said.push(l), now: () => Date.now() })
    return { store, said, off }
  }

  it('announces another agent finishing and asking, not the box’s own', () => {
    const { store, said, off } = setup({ value: true }, 'a')
    vi.advanceTimersByTime(MIN_WORK_MS)
    store.set('a', act('a', 'replied'))
    store.set('b', act('b', 'replied'))
    vi.advanceTimersByTime(500)
    expect(said).toEqual(['Forge 完成了'])
    off()
  })

  it('off says nothing, and turning on never announces the past', () => {
    const on = { value: false }
    const { store, said, off } = setup(on, null)
    vi.advanceTimersByTime(MIN_WORK_MS)
    store.set('b', act('b', 'replied'))
    vi.advanceTimersByTime(500)
    on.value = true
    store.set('a', act('a', 'thinking'))
    vi.advanceTimersByTime(500)
    expect(said).toEqual([])
    off()
  })
})
