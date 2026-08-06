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
    ...over,
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
    glance: {
      status: 'Herding… (esc to interrupt · 3s)',
      tools: ['Read a.ts', 'Edit b.ts'],
      message: null,
    },
    pendingInput: null,
    turnCount: 12,
    turnStartedAt: NOW - 30_000,
    updatedAt: NOW - 1_000,
    ...over,
  } as TerminalActivity
}

describe('buildAgentRows — the roster is the spine', () => {
  it('gives every roster entry exactly one row', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'a' }), entry({ id: 'b' })],
      activities: {},
      now: NOW,
    })
    expect([...out.live, ...out.quiet].map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('joins activity on the registry id, which IS the terminal node id', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 't7' })],
      activities: { t7: activity({ terminalId: 't7' }) },
      now: NOW,
    })
    expect(out.live[0].turn?.title).toBe('Wire the sidebar')
  })

  it('does not hand one agent another agent’s turn', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'mine' })],
      activities: { other: activity({ terminalId: 'other' }) },
      now: NOW,
    })
    expect(out.quiet.find((r) => r.id === 'mine')?.turn).toBeNull()
  })
})

describe('buildAgentRows — phase', () => {
  const phaseOf = (a: Partial<TerminalActivity>, e: Partial<AgentRegistryEntry> = {}): string => {
    const out = buildAgentRows({ roster: [entry(e)], activities: { t1: activity(a) }, now: NOW })
    return [...out.live, ...out.quiet][0].phase
  }

  it('maps a thinking agent to working', () =>
    expect(phaseOf({ phase: 'thinking' })).toBe('working'))
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
      now: NOW,
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
      now: NOW,
    })
    expect(out.live[0].turn?.tools).toEqual([])
  })

  it('falls back to the reply when the turn is complete', () => {
    const out = buildAgentRows({
      roster: [entry()],
      activities: { t1: activity({ phase: 'replied', reply: 'all 970 tests pass' }) },
      now: NOW,
    })
    expect(out.live[0].turn?.latest?.text).toBe('all 970 tests pass')
  })

  it('leaves latest null when there is nothing to say, so the row can read Ready', () => {
    const out = buildAgentRows({
      roster: [entry()],
      activities: { t1: activity({ phase: 'idle', reply: null }) },
      now: NOW,
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
    const out = buildAgentRows({
      roster,
      activities: { a0: activity({ terminalId: 'a0' }) },
      now: NOW,
    })
    expect(out.live).toHaveLength(1)
    expect(out.quiet).toHaveLength(227)
  })

  it('keeps an offline agent visible when it was doing something', () => {
    const out = buildAgentRows({
      roster: [entry({ active: false })],
      activities: { t1: activity({ phase: 'waiting' }) },
      now: NOW,
    })
    expect(out.live.map((r) => r.id)).toEqual(['t1'])
    expect(out.live[0].phase).toBe('offline')
  })
})

describe('buildAgentRows — ordering', () => {
  // Finished turns, so the key is their last output — the case where
  // "most recent first" means exactly what it says.
  const done = (id: string, updatedAt: number): TerminalActivity =>
    activity({ terminalId: id, phase: 'idle', reply: 'done', updatedAt })
  const three = {
    roster: [entry({ id: 'old' }), entry({ id: 'new' }), entry({ id: 'mid' })],
    activities: {
      old: done('old', NOW - 9000),
      new: done('new', NOW - 1000),
      mid: done('mid', NOW - 5000),
    },
    now: NOW,
  }

  it('sorts by last activity, most recent first', () => {
    expect(buildAgentRows(three).live.map((r) => r.id)).toEqual(['new', 'mid', 'old'])
  })

  it('does NOT float waiting above a more recent row by default', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'w' }), entry({ id: 'r' })],
      activities: {
        w: activity({ terminalId: 'w', phase: 'waiting', updatedAt: NOW - 9000 }),
        r: activity({ terminalId: 'r', phase: 'idle', reply: 'x', updatedAt: NOW - 1000 }),
      },
      now: NOW,
    })
    expect(out.live.map((r) => r.id)).toEqual(['r', 'w'])
  })

  it('floats waiting to the top only when asked', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'w' }), entry({ id: 'r' })],
      activities: {
        w: activity({ terminalId: 'w', phase: 'waiting', updatedAt: NOW - 9000 }),
        r: activity({ terminalId: 'r', phase: 'idle', reply: 'x', updatedAt: NOW - 1000 }),
      },
      now: NOW,
      floatWaiting: true,
    })
    expect(out.live.map((r) => r.id)).toEqual(['w', 'r'])
  })

  it('sorts the quiet bucket newest-spawned first so it is not random', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'a', spawnedAt: 100 }), entry({ id: 'b', spawnedAt: 900 })],
      activities: {},
      now: NOW,
    })
    expect(out.quiet.map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('buildAgentRows — workspace facets', () => {
  const roster = [
    entry({ id: 'a', workspaceId: 'ws1', workspaceName: 'cookrew-dev' }),
    entry({ id: 'b', workspaceId: 'ws2', workspaceName: 'voice', spawnedAt: 100 }),
    entry({ id: 'c', workspaceId: 'ws2', workspaceName: 'voice', spawnedAt: 900 }),
  ]

  it('counts every workspace over the WHOLE roster, not just live rows', () => {
    const out = buildAgentRows({
      roster,
      activities: { a: activity({ terminalId: 'a' }) },
      now: NOW,
    })
    expect(out.workspaces).toEqual([
      { id: 'ws1', name: 'cookrew-dev', total: 1 },
      { id: 'ws2', name: 'voice', total: 2 },
    ])
  })

  it('filters rows to one workspace without collapsing the facet counts', () => {
    const out = buildAgentRows({ roster, activities: {}, now: NOW, workspaceId: 'ws2' })
    expect([...out.live, ...out.quiet].map((r) => r.id)).toEqual(['c', 'b'])
    expect(out.workspaces).toHaveLength(2)
  })
})

/**
 * updatedAt is stamped at SERIALIZATION time (turn-tracker.activityOf), and
 * the tracker pushes every 250ms while an agent works — so it advances four
 * times a second whether or not anything changed. Ordering on it made the list
 * churn continuously. The sort key has to be stable for as long as the row's
 * state is.
 */
describe('buildAgentRows — the order must hold still', () => {
  const working = (updatedAt: number): TerminalActivity =>
    activity({ terminalId: 'w', phase: 'thinking', turnStartedAt: NOW - 600_000, updatedAt })

  it('does not move a working agent as its output streams', () => {
    const roster = [entry({ id: 'w' }), entry({ id: 'done' })]
    const order = (updatedAt: number): string[] =>
      buildAgentRows({
        roster,
        activities: {
          w: working(updatedAt),
          done: activity({
            terminalId: 'done',
            phase: 'idle',
            reply: 'finished',
            turnStartedAt: NOW - 300_000,
            updatedAt: NOW - 300_000,
          }),
        },
        now: NOW,
      }).live.map((r) => r.id)

    const first = order(NOW - 5000)
    // four pushes later — 1s of streaming output, nothing else changed
    expect(order(NOW - 4750)).toEqual(first)
    expect(order(NOW - 4500)).toEqual(first)
    expect(order(NOW)).toEqual(first)
  })

  it('ranks an in-flight turn by when it STARTED, not by its last output', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'old-turn' }), entry({ id: 'new-turn' })],
      activities: {
        // started long ago, still streaming right now
        'old-turn': activity({
          terminalId: 'old-turn',
          phase: 'thinking',
          turnStartedAt: NOW - 900_000,
          updatedAt: NOW,
        }),
        // started recently, also streaming
        'new-turn': activity({
          terminalId: 'new-turn',
          phase: 'thinking',
          turnStartedAt: NOW - 60_000,
          updatedAt: NOW,
        }),
      },
      now: NOW,
    })
    expect(out.live.map((r) => r.id)).toEqual(['new-turn', 'old-turn'])
  })

  it('still uses the last output time for a finished turn, which stops moving', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'a' }), entry({ id: 'b' })],
      activities: {
        a: activity({ terminalId: 'a', phase: 'idle', reply: 'x', updatedAt: NOW - 9000 }),
        b: activity({ terminalId: 'b', phase: 'idle', reply: 'y', updatedAt: NOW - 1000 }),
      },
      now: NOW,
    })
    expect(out.live.map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('falls back to last output when a turn reports no start time', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'x' })],
      activities: {
        x: activity({
          terminalId: 'x',
          phase: 'thinking',
          turnStartedAt: null,
          updatedAt: NOW - 20,
        }),
      },
      now: NOW,
    })
    expect(out.live[0].lastActivityAt).toBe(NOW - 20)
  })
})

/**
 * REFACTOR GUARD (checkpoint-as-identity) — what the "N CK" chip claims.
 *
 * The row renders turnCount as "{n} CK", i.e. "this agent has n CHECKPOINTS".
 * buildAgentRows only forwards activity.turnCount, so if the unification
 * changes that field to mean something adjacent — records RETAINED after a cap
 * eviction, blocks loaded in the current window, rows merged — the chip keeps
 * rendering and starts lying. A count that quietly changed meaning is the
 * exact failure we already hit once, and it cannot be spotted by eye.
 *
 * Ordering is pinned above ("the order must hold still"); this pins the count.
 */
describe('buildAgentRows — the checkpoint count must stay the checkpoint count', () => {
  it('forwards the agent’s OWN count, unmodified', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'a' })],
      activities: { a: activity({ terminalId: 'a', turnCount: 47 }) },
      now: NOW
    })
    expect([...out.live, ...out.quiet][0].turnCount).toBe(47)
  })

  it('does not cap, window or otherwise shrink a long history', () => {
    // A 229-checkpoint agent must read 229, not a retained-window size.
    const out = buildAgentRows({
      roster: [entry({ id: 'a' })],
      activities: { a: activity({ terminalId: 'a', turnCount: 229 }) },
      now: NOW
    })
    expect([...out.live, ...out.quiet][0].turnCount).toBe(229)
  })

  it('is 0 — not undefined, not another agent’s — when the agent has no activity', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'a' }), entry({ id: 'b' })],
      activities: { b: activity({ terminalId: 'b', turnCount: 12 }) },
      now: NOW
    })
    const rows = [...out.live, ...out.quiet]
    expect(rows.find((r) => r.id === 'a')?.turnCount).toBe(0)
    expect(rows.find((r) => r.id === 'b')?.turnCount).toBe(12)
  })

  it('never borrows a neighbour’s count when ids interleave', () => {
    const out = buildAgentRows({
      roster: [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })],
      activities: {
        a: activity({ terminalId: 'a', turnCount: 1 }),
        b: activity({ terminalId: 'b', turnCount: 2 }),
        c: activity({ terminalId: 'c', turnCount: 3 })
      },
      now: NOW
    })
    const byId = new Map([...out.live, ...out.quiet].map((r) => [r.id, r.turnCount]))
    expect([byId.get('a'), byId.get('b'), byId.get('c')]).toEqual([1, 2, 3])
  })
})
