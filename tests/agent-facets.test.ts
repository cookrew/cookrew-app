import { describe, expect, it } from 'vitest'
import {
  applyFilter,
  buildFacets,
  eventClock,
  retainFacetEvents,
  normalizePreset,
  type AgentFilter,
  type FacetEvent,
} from '../src/renderer/src/agent-facets'
import type { AgentRow } from '../src/renderer/src/agent-rows'

const NOW = 1_800_000_000_000

function row(over: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 't1',
    name: 'Velvet',
    preset: 'Claude Code',
    role: null,
    orch: false,
    active: true,
    workspaceId: 'ws1',
    workspaceName: 'cookrew-dev',
    cwd: '/w',
    spawnedAt: NOW - 600_000,
    phase: 'done',
    turn: null,
    turnCount: 0,
    lastActivityAt: NOW - 600_000,
    ...over,
  }
}

const ev = (over: Partial<FacetEvent> = {}): FacetEvent => ({
  type: 'terminal.created',
  entityId: 't1',
  timestamp: NOW - 1000,
  ...over,
})

/**
 * The registry records the same harness under different spellings — this
 * machine has 154 "Claude Code" AND 10 "claude", 41 "Codex" AND 3 "codex".
 * Unnormalised, the facet row shows the same preset twice with split counts.
 */
describe('normalizePreset', () => {
  it('folds the lowercase harness aliases onto their display name', () => {
    expect(normalizePreset('claude')).toBe(normalizePreset('Claude Code'))
    expect(normalizePreset('codex')).toBe(normalizePreset('Codex'))
  })

  it('leaves an unknown preset alone rather than guessing', () => {
    expect(normalizePreset('Pi')).toBe('Pi')
    expect(normalizePreset('Shell')).toBe('Shell')
  })

  it('does not fold two genuinely different presets together', () => {
    expect(normalizePreset('Codex')).not.toBe(normalizePreset('Claude Code'))
  })
})

describe('buildFacets', () => {
  const rows = [
    row({ id: 'a', preset: 'Claude Code', role: 'Developer', workspaceName: 'cookrew-dev' }),
    row({ id: 'b', preset: 'claude', role: null, workspaceName: 'cookrew-dev' }),
    row({
      id: 'c',
      preset: 'Codex',
      role: 'Developer',
      workspaceId: 'ws2',
      workspaceName: 'voice',
    }),
    row({ id: 'd', preset: 'Pi', role: null, active: false }),
  ]

  it('counts presets after normalising, so one harness is one chip', () => {
    const claude = buildFacets(rows).presets.find((p) => p.value === 'Claude Code')
    expect(claude?.count).toBe(2)
  })

  it('offers a chip per role, skipping the agents that have none', () => {
    expect(buildFacets(rows).roles).toEqual([{ value: 'Developer', count: 2 }])
  })

  it('counts workspaces over the whole roster', () => {
    // a, b and d all sit in ws1; only c is elsewhere.
    expect(buildFacets(rows).workspaces).toEqual([
      { value: 'cookrew-dev', count: 3, id: 'ws1' },
      { value: 'voice', count: 1, id: 'ws2' },
    ])
  })

  it('counts what is live versus retired', () => {
    const { states } = buildFacets(rows)
    expect(states.find((s) => s.value === 'active')?.count).toBe(3)
    expect(states.find((s) => s.value === 'inactive')?.count).toBe(1)
  })

  it('sorts each facet by count so the useful chips come first', () => {
    const many = [...rows, row({ id: 'e', preset: 'Codex' }), row({ id: 'f', preset: 'Codex' })]
    expect(buildFacets(many).presets[0].value).toBe('Codex')
  })
})

describe('applyFilter', () => {
  const rows = [
    row({ id: 'a', preset: 'Claude Code', role: 'Developer', workspaceId: 'ws1' }),
    row({ id: 'b', preset: 'Codex', role: null, workspaceId: 'ws1' }),
    row({ id: 'c', preset: 'Codex', role: 'QA', workspaceId: 'ws2', active: false }),
  ]
  const none: AgentFilter = { presets: [], roles: [], workspaceIds: [], states: [] }

  it('passes everything through when nothing is selected', () => {
    expect(applyFilter(rows, none).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('filters by preset, matching the normalised name', () => {
    expect(applyFilter(rows, { ...none, presets: ['Codex'] }).map((r) => r.id)).toEqual(['b', 'c'])
  })

  it('OR-s within one facet', () => {
    expect(applyFilter(rows, { ...none, presets: ['Codex', 'Claude Code'] })).toHaveLength(3)
  })

  it('AND-s across facets — narrowing, as a filter should', () => {
    const out = applyFilter(rows, { ...none, presets: ['Codex'], roles: ['QA'] })
    expect(out.map((r) => r.id)).toEqual(['c'])
  })

  it('filters by workspace and by state', () => {
    expect(applyFilter(rows, { ...none, workspaceIds: ['ws2'] }).map((r) => r.id)).toEqual(['c'])
    expect(applyFilter(rows, { ...none, states: ['inactive'] }).map((r) => r.id)).toEqual(['c'])
  })

  it('folds a lowercase-aliased row in under its display chip', () => {
    const aliased = [row({ id: 'x', preset: 'claude' })]
    expect(applyFilter(aliased, { ...none, presets: ['Claude Code'] })).toHaveLength(1)
  })
})

/**
 * The event log is the ONLY cross-workspace signal of when an agent was last
 * touched — live turn state exists for the loaded workspace alone. 371 of 373
 * terminal.* events on this machine join to a registry agent by entityId.
 */
describe('eventClock', () => {
  it('takes the newest event per agent', () => {
    const clock = eventClock([
      ev({ entityId: 'a', timestamp: 100 }),
      ev({ entityId: 'a', timestamp: 900, type: 'terminal.killed' }),
      ev({ entityId: 'a', timestamp: 500 }),
    ])
    expect(clock.a).toBe(900)
  })

  it('tracks agents independently', () => {
    const clock = eventClock([
      ev({ entityId: 'a', timestamp: 100 }),
      ev({ entityId: 'b', timestamp: 900 }),
    ])
    expect(clock).toEqual({ a: 100, b: 900 })
  })

  it('ignores events that name no agent', () => {
    expect(eventClock([ev({ entityId: '', timestamp: 100 })])).toEqual({})
  })

  it('ignores workspace churn, which is a third of the log and about no agent', () => {
    const clock = eventClock([
      ev({ entityId: 'a', timestamp: 100 }),
      ev({ entityId: 'a', timestamp: 900, type: 'workspace.switched' }),
    ])
    expect(clock.a).toBe(100)
  })

  it('survives an empty log', () => {
    expect(eventClock([])).toEqual({})
  })
})

describe('retainFacetEvents', () => {
  it('keeps the newest events in their original order', () => {
    const events = [1, 2, 3, 4, 5].map((timestamp) => ev({ timestamp }))
    expect(retainFacetEvents(events, 3).map((event) => event.timestamp)).toEqual([3, 4, 5])
  })

  it('does not allocate a replacement while the window is within its bound', () => {
    const events = [ev({ timestamp: 1 }), ev({ timestamp: 2 })]
    expect(retainFacetEvents(events, 2)).toBe(events)
  })
})
