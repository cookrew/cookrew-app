import { describe, expect, it } from 'vitest'
import { searchAgents, searchCorpus } from '../src/renderer/src/agent-search'
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
    cwd: '/w/cookrew-dev',
    spawnedAt: NOW - 600_000,
    phase: 'done',
    turn: {
      title: 'Wire the sidebar',
      ask: 'one component, two levels',
      tools: ['Read RosterPanel.tsx', 'Edit AgentRow.tsx'],
      latest: { text: 'three tests red', tone: 'done' },
      pendingInput: null,
      tail: null
    },
    turnCount: 12,
    lastActivityAt: NOW - 1000,
    ...over
  }
}

describe('searchAgents — no query', () => {
  it('returns everything, in the order it was given', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]
    expect(searchAgents(rows, '').map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('treats a whitespace-only query as no query', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })]
    expect(searchAgents(rows, '   ').map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('searchAgents — what it matches', () => {
  it('matches the agent name', () => {
    const rows = [row({ id: 'v', name: 'Velvet' }), row({ id: 'f', name: 'Forge' })]
    expect(searchAgents(rows, 'forge').map((r) => r.id)).toEqual(['f'])
  })

  it('is case-insensitive', () => {
    expect(searchAgents([row({ name: 'Velvet' })], 'VELVET')).toHaveLength(1)
  })

  it('matches the role, preset and workspace', () => {
    const rows = [
      row({ id: 'dev', role: 'Developer' }),
      row({ id: 'qa', role: 'QA (Browser)' }),
      row({ id: 'codex', preset: 'Codex' }),
      row({ id: 'voice', workspaceName: 'voice-gateway' })
    ]
    expect(searchAgents(rows, 'developer').map((r) => r.id)).toEqual(['dev'])
    expect(searchAgents(rows, 'codex').map((r) => r.id)).toEqual(['codex'])
    expect(searchAgents(rows, 'voice').map((r) => r.id)).toEqual(['voice'])
  })

  it('searches the CONVERSATION — recap, ask and reply', () => {
    const rows = [
      row({ id: 'recap', turn: { ...row().turn!, title: 'Rebuild the main process' } }),
      row({ id: 'ask', turn: { ...row().turn!, ask: 'restart main so the fix takes effect' } }),
      row({
        id: 'reply',
        turn: { ...row().turn!, latest: { text: 'all 1021 tests pass', tone: 'done' } }
      })
    ]
    expect(searchAgents(rows, 'rebuild').map((r) => r.id)).toEqual(['recap'])
    expect(searchAgents(rows, 'restart').map((r) => r.id)).toEqual(['ask'])
    expect(searchAgents(rows, '1021').map((r) => r.id)).toEqual(['reply'])
  })

  it('searches the tool calls', () => {
    const rows = [row({ id: 'a', turn: { ...row().turn!, tools: ['Bash npm run typecheck'] } })]
    expect(searchAgents(rows, 'typecheck').map((r) => r.id)).toEqual(['a'])
  })

  it('survives a row that has never run a turn', () => {
    const rows = [row({ id: 'quiet', name: 'QA Codex', turn: null })]
    expect(searchAgents(rows, 'codex').map((r) => r.id)).toEqual(['quiet'])
    expect(searchAgents(rows, 'nothing')).toEqual([])
  })
})

describe('searchAgents — every term must match', () => {
  it('AND-s the terms rather than OR-ing them', () => {
    const rows = [
      row({ id: 'both', name: 'Forge', role: 'Developer' }),
      row({ id: 'one', name: 'Velvet', role: 'Developer' })
    ]
    expect(searchAgents(rows, 'forge developer').map((r) => r.id)).toEqual(['both'])
  })

  it('lets terms match across DIFFERENT fields', () => {
    const rows = [row({ id: 'x', name: 'Forge', turn: { ...row().turn!, ask: 'land the sampler' } })]
    expect(searchAgents(rows, 'forge sampler').map((r) => r.id)).toEqual(['x'])
  })

  it('drops a row when any term is missing', () => {
    expect(searchAgents([row({ name: 'Forge' })], 'forge banana')).toEqual([])
  })
})

describe('searchAgents — ranking', () => {
  it('ranks a name match above a reply match', () => {
    const rows = [
      row({ id: 'in-reply', name: 'Velvet', turn: { ...row().turn!, latest: { text: 'forge it', tone: 'done' } } }),
      row({ id: 'is-name', name: 'Forge' })
    ]
    expect(searchAgents(rows, 'forge').map((r) => r.id)).toEqual(['is-name', 'in-reply'])
  })

  it('ranks the recap above the reply', () => {
    const rows = [
      row({ id: 'reply', turn: { ...row().turn!, title: null, latest: { text: 'sidebar', tone: 'done' } } }),
      row({ id: 'recap', turn: { ...row().turn!, title: 'sidebar work' } })
    ]
    expect(searchAgents(rows, 'sidebar').map((r) => r.id)).toEqual(['recap', 'reply'])
  })

  it('keeps the activity order when scores tie — search refines, it does not shuffle', () => {
    const rows = [
      row({ id: 'first', name: 'Forge', lastActivityAt: NOW }),
      row({ id: 'second', name: 'Forge', lastActivityAt: NOW - 9000 }),
      row({ id: 'third', name: 'Forge', lastActivityAt: NOW - 90_000 })
    ]
    expect(searchAgents(rows, 'forge').map((r) => r.id)).toEqual(['first', 'second', 'third'])
  })

  it('prefers a whole-name hit over a name that merely contains it', () => {
    const rows = [
      row({ id: 'contains', name: 'Forgemaster' }),
      row({ id: 'exact', name: 'Forge' })
    ]
    expect(searchAgents(rows, 'forge').map((r) => r.id)).toEqual(['exact', 'contains'])
  })
})

/**
 * The corpus is the ONE place that decides what is searchable. Today it is what
 * the renderer already holds; when a cross-workspace turn search lands it grows
 * here and nothing else changes.
 */
describe('searchCorpus', () => {
  it('covers identity and conversation together', () => {
    const text = searchCorpus(row({ name: 'Forge', role: 'Developer' })).toLowerCase()
    for (const term of ['forge', 'developer', 'claude code', 'cookrew-dev', 'wire the sidebar']) {
      expect(text).toContain(term)
    }
  })

  it('is empty of nothing — a quiet agent still has identity', () => {
    expect(searchCorpus(row({ turn: null })).length).toBeGreaterThan(0)
  })
})
