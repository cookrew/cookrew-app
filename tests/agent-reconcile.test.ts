// The registry must not outlive the thing it describes.
//
// 2026-10-31: Beacon's card read RESTING with a prompt box after its pane was
// gone. `active` only flips on an explicit dismiss/kill/exit event, so a pane
// lost to a herdr restart or a dead login session stays "active" forever
// (Beacon had eight such entries). The card is right to trust the registry —
// the registry is what has to be kept true.
import { describe, expect, it } from 'vitest'
import { staleAgentIds } from '../src/main/agent-reconcile'
import type { AgentRegistryEntry } from '../src/main/agent-registry'

function entry(id: string, active = true): AgentRegistryEntry {
  return {
    id, name: id, preset: 'Claude Code', command: 'claude', role: null,
    cwd: '/tmp', workspaceId: 'ws', workspaceName: 'Cookrew Dev', orch: false,
    spawnedAt: 1, active, updatedAt: 1
  }
}

describe('staleAgentIds — what is claiming to run and is not', () => {
  it('marks an active entry with no live session', () => {
    expect(staleAgentIds({ entries: [entry('a'), entry('b')], observable: true, live: new Set(['a']) }))
      .toEqual(['b'])
  })

  it('leaves an already-inactive entry alone', () => {
    expect(staleAgentIds({ entries: [entry('a', false)], observable: true, live: new Set() })).toEqual([])
  })

  it('marks nothing when the app cannot see the multiplexer', () => {
    // Blindness is not absence: a dead herdr must not flip the whole fleet to
    // offline while the agents may be running perfectly well.
    expect(staleAgentIds({ entries: [entry('a'), entry('b')], observable: false, live: new Set() })).toEqual([])
  })

  it('never touches an exempt (served) entry', () => {
    expect(
      staleAgentIds({ entries: [entry('a'), entry('b')], observable: true, live: new Set(), exempt: new Set(['a']) })
    ).toEqual(['b'])
  })

  it('is a no-op when everything claims to be running and is', () => {
    expect(staleAgentIds({ entries: [entry('a')], observable: true, live: new Set(['a']) })).toEqual([])
  })
})
