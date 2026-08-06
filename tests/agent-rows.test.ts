import { describe, expect, it } from 'vitest'
import { buildAgentRows } from '../src/renderer/src/agent-rows'
import type { AgentRegistryEntry } from '../src/renderer/src/agent-registry'
import type { TerminalActivity } from '../src/shared/turn'

const NOW = 1_800_000_000_000

function entry(over: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    id: 't1',
    name: 'Velvet',
    preset: 'Claude Code',
    role: null,
    cwd: '/w/cookrew-dev',
    workspaceId: 'ws1',
    workspaceName: 'cookrew-dev',
    spawnedAt: NOW - 600_000,
    orch: false,
    active: true,
    ...over
  }
}

function activity(over: Partial<TerminalActivity> = {}): TerminalActivity {
  return {
    terminalId: 't1',
    agent: true,
    phase: 'thinking',
    prompt: 'one component, two levels',
    reply: null,
    title: 'Wire the sidebar',
    lines: [],
    glance: { status: 'Herding… (esc to interrupt · 3s)', tools: ['Read a.ts', 'Edit b.ts'], message: null },
    pendingInput: null,
    turnCount: 12,
    turnStartedAt: NOW - 30_000,
    updatedAt: NOW - 1_000,
    ...over
  } as TerminalActivity
}

describe('buildAgentRows — the roster is the spine', () => {
  it('gives every roster entry exactly one row', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'a' }), entry({ id: 'b' })],
      activities: {},
      now: NOW
    })
    expect([...out.live, ...out.quiet].map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('joins activity on the registry id, which IS the terminal node id', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 't7' })],
      activities: { t7: activity({ terminalId: 't7' }) },
      now: NOW
    })
    expect(out.live[0].turn?.title).toBe('Wire the sidebar')
  })

  it('does not hand one agent another agent’s turn', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'mine' })],
      activities: { other: activity({ terminalId: 'other' }) },
      now: NOW
    })
    expect(out.quiet.find((r) => r.id === 'mine')?.turn).toBeNull()
  })
})

describe('buildAgentRows — phase', () => {
  const phaseOf = (a: Partial<TerminalActivity>, e: Partial<AgentRegistryEntry> = {}): string => {
    const out = buildAgentRows({ roster: [entry(e)], activities: { t1: activity(a) }, now: NOW })
    return [...out.live, ...out.quiet][0].phase
  }

  it('maps a thinking agent to working', () => expect(phaseOf({ phase: 'thinking' })).toBe('working'))
  it('maps a waiting agent to waiting', () => expect(phaseOf({ phase: 'waiting' })).toBe('waiting'))
  it('maps a replied agent to done', () => expect(phaseOf({ phase: 'replied' })).toBe('done'))

  it('maps idle WITH a tracked turn to done, not quiet', () => {
    expect(phaseOf({ phase: 'idle', reply: 'all tests pass' })).toBe('done')
  })

  it('maps idle with no turn at all to quiet', () => {
    expect(phaseOf({ phase: 'idle', prompt: null, reply: null })).toBe('quiet')
  })

  it('reports an inactive agent as offline whatever its last activity said', () => {
    expect(phaseOf({ phase: 'thinking' }, { active: false })).toBe('offline')
  })
})

describe('buildAgentRows — the turn the row shows', () => {
  it('takes the ask from the prompt’s first meaningful line', () => {
    const out = buildAgentRows({
      roster: [entry()],
      activities: { t1: activity({ prompt: '\n\n  restart main  \nsecond line' }) },
      now: NOW
    })
    expect(out.live[0].turn?.ask).toBe('restart main')
  })

  it('strips the "esc to interrupt" chrome off the live status', () => {
    const out = buildAgentRows({ roster: [entry()], activities: { t1: activity() }, now: NOW })
    expect(out.live[0].turn?.latest?.text).toBe('Herding…')
  })

  it('shows the newest tool call while working', () => {
    const out = buildAgentRows({ roster: [entry()], activities: { t1: activity() }, now: NOW })
    expect(out.live[0].turn?.tools.at(-1)).toBe('Edit b.ts')
  })

  it('shows no tool trail once the turn is over', () => {
    const out = buildAgentRows({
      roster: [entry()],
      activities: { t1: activity({ phase: 'idle', reply: 'done' }) },
      now: NOW
    })
    expect(out.live[0].turn?.tools).toEqual([])
  })

  it('falls back to the reply when the turn is complete', () => {
    const out = buildAgentRows({
      roster: [entry()],
      activities: { t1: activity({ phase: 'replied', reply: 'all 970 tests pass' }) },
      now: NOW
    })
    expect(out.live[0].turn?.latest?.text).toBe('all 970 tests pass')
  })

  it('leaves latest null when there is nothing to say, so the row can read Ready', () => {
    const out = buildAgentRows({
      roster: [entry()],
      activities: { t1: activity({ phase: 'idle', reply: null }) },
      now: NOW
    })
    expect([...out.live, ...out.quiet][0].turn?.latest ?? null).toBeNull()
  })
})

describe('buildAgentRows — the 228 collapse', () => {
  it('sends an agent with no activity to the quiet bucket', () => {
    const out = buildAgentRows({ roster: [entry({ id: 'never' })], activities: {}, now: NOW })
    expect(out.live).toHaveLength(0)
    expect(out.quiet.map((r) => r.id)).toEqual(['never'])
  })

  it('collapses 228 identity-only agents behind one live row', () => {
    const roster = Array.from({ length: 228 }, (_, i) => entry({ id: `a${i}` }))
    const out = buildAgentRows({ roster, activities: { a0: activity({ terminalId: 'a0' }) }, now: NOW })
    expect(out.live).toHaveLength(1)
    expect(out.quiet).toHaveLength(227)
  })

  it('keeps an offline agent visible when it was doing something', () => {
    const out = buildAgentRows({
      roster: [entry({ active: false })],
      activities: { t1: activity({ phase: 'waiting' }) },
      now: NOW
    })
    expect(out.live.map((r) => r.id)).toEqual(['t1'])
    expect(out.live[0].phase).toBe('offline')
  })
})

describe('buildAgentRows — ordering', () => {
  const three = {
    roster: [entry({ id: 'old' }), entry({ id: 'new' }), entry({ id: 'mid' })],
    activities: {
      old: activity({ terminalId: 'old', updatedAt: NOW - 9000 }),
      new: activity({ terminalId: 'new', updatedAt: NOW - 1000 }),
      mid: activity({ terminalId: 'mid', updatedAt: NOW - 5000 })
    },
    now: NOW
  }

  it('sorts by last activity, most recent first', () => {
    expect(buildAgentRows(three).live.map((r) => r.id)).toEqual(['new', 'mid', 'old'])
  })

  it('does NOT float waiting above a more recent row by default', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'w' }), entry({ id: 'r' })],
      activities: {
        w: activity({ terminalId: 'w', phase: 'waiting', updatedAt: NOW - 9000 }),
        r: activity({ terminalId: 'r', phase: 'idle', reply: 'x', updatedAt: NOW - 1000 })
      },
      now: NOW
    })
    expect(out.live.map((r) => r.id)).toEqual(['r', 'w'])
  })

  it('floats waiting to the top only when asked', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'w' }), entry({ id: 'r' })],
      activities: {
        w: activity({ terminalId: 'w', phase: 'waiting', updatedAt: NOW - 9000 }),
        r: activity({ terminalId: 'r', phase: 'idle', reply: 'x', updatedAt: NOW - 1000 })
      },
      now: NOW,
      floatWaiting: true
    })
    expect(out.live.map((r) => r.id)).toEqual(['w', 'r'])
  })

  it('sorts the quiet bucket newest-spawned first so it is not random', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'a', spawnedAt: 100 }), entry({ id: 'b', spawnedAt: 900 })],
      activities: {},
      now: NOW
    })
    expect(out.quiet.map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('buildAgentRows — workspace facets', () => {
  const roster = [
    entry({ id: 'a', workspaceId: 'ws1', workspaceName: 'cookrew-dev' }),
    entry({ id: 'b', workspaceId: 'ws2', workspaceName: 'voice', spawnedAt: 100 }),
    entry({ id: 'c', workspaceId: 'ws2', workspaceName: 'voice', spawnedAt: 900 })
  ]

  it('counts every workspace over the WHOLE roster, not just live rows', () => {
    const out = buildAgentRows({ roster, activities: { a: activity({ terminalId: 'a' }) }, now: NOW })
    expect(out.workspaces).toEqual([
      { id: 'ws1', name: 'cookrew-dev', total: 1 },
      { id: 'ws2', name: 'voice', total: 2 }
    ])
  })

  it('filters rows to one workspace without collapsing the facet counts', () => {
    const out = buildAgentRows({ roster, activities: {}, now: NOW, workspaceId: 'ws2' })
    expect([...out.live, ...out.quiet].map((r) => r.id)).toEqual(['c', 'b'])
    expect(out.workspaces).toHaveLength(2)
  })
})
