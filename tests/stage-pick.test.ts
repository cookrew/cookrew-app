// THE STAGE (2026-10-30): which one card fills the window, and the faces' order.
import { describe, expect, it } from 'vitest'
import type { AgentRow } from '../src/renderer/src/agent-rows'
import { diffPopped, pickBackground, railOrder, type PoppedItem } from '../src/renderer/src/stage/stage-pick'

const row = (id: string, phase: AgentRow['phase'], at: number): AgentRow => ({
  id,
  name: id,
  preset: 'claude',
  role: null,
  orch: false,
  active: true,
  workspaceId: 'w',
  workspaceName: 'W',
  cwd: '/',
  spawnedAt: 0,
  phase,
  turn: null,
  turnCount: 0,
  lastActivityAt: at
})
const pop = (id: string, terminalId: string | null, at: number): PoppedItem => ({ id, kind: 'browser', terminalId, at })

describe('the background', () => {
  it('is the newest agent waiting on a choice, however old the rest', () => {
    const rows = [row('a', 'done', 900), row('b', 'waiting', 100), row('c', 'waiting', 200)]
    expect(pickBackground(rows, [pop('x', 'a', 950)], null)).toEqual({ terminalId: 'c', item: null, why: 'choose' })
  })

  it('then the newest of a finished turn and a card that popped up on an agent', () => {
    const rows = [row('a', 'done', 300), row('b', 'working', 999)]
    expect(pickBackground(rows, [pop('x', 'b', 200)], null)).toEqual({ terminalId: 'a', item: null, why: 'review' })
    expect(pickBackground(rows, [pop('x', 'b', 400)], null)).toEqual({ terminalId: 'b', item: { id: 'x', kind: 'browser' }, why: 'popped' })
  })

  it('ignores a card wired to no agent, or to one that is gone', () => {
    const rows = [row('a', 'done', 300)]
    expect(pickBackground(rows, [pop('x', null, 900), pop('y', 'gone', 900)], null)?.why).toBe('review')
  })

  it('falls back to the agent that moved last, and to nothing without agents', () => {
    expect(pickBackground([row('a', 'working', 5), row('b', 'quiet', 9)], [], null)).toEqual({ terminalId: 'b', item: null, why: 'latest' })
    expect(pickBackground([], [], null)).toBeNull()
  })

  it('holds what you pinned over everything, until that agent is gone', () => {
    const rows = [row('a', 'waiting', 900), row('b', 'quiet', 1)]
    expect(pickBackground(rows, [], { terminalId: 'b', item: null })).toEqual({ terminalId: 'b', item: null, why: 'pinned' })
    expect(pickBackground(rows, [], { terminalId: 'gone', item: null })?.why).toBe('choose')
  })
})

describe('the faces', () => {
  it('run: needs you, working, finished, then the rest; newest first within each', () => {
    const rows = [row('q', 'quiet', 9), row('d', 'done', 8), row('w1', 'waiting', 1), row('k', 'working', 3), row('w2', 'waiting', 2)]
    expect(railOrder(rows).map((r) => r.id)).toEqual(['w2', 'w1', 'k', 'd', 'q'])
  })
})

describe('what popped up', () => {
  const owner = (id: string): string | null => (id === 'n1' ? 't1' : null)
  it('a first look only learns what is there', () => {
    const first = diffPopped(null, [{ id: 'b1', kind: 'browser' }], owner, 10)
    expect(first.popped).toEqual([])
    expect([...first.known]).toEqual(['b1'])
  })
  it('a later look reports the new ones, with their agent', () => {
    const next = diffPopped(new Set(['b1']), [{ id: 'b1', kind: 'browser' }, { id: 'n1', kind: 'note' }], owner, 20)
    expect(next.popped).toEqual([{ id: 'n1', kind: 'note', terminalId: 't1', at: 20 }])
  })
})
