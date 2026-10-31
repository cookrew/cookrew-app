// The roster a page holds is the one it fetched at mount: neither bridge
// pushed registry changes (useRoster's onAgentRegistry fell back to a mock
// listener), so an agent that exited stayed on the page as resting until
// something remounted the hook. Measured in the round-2 browser eval: the
// pane was gone in 0.5 s, the registry said inactive in 0.6 s, and the face
// read offline 11.3 s later. The registry now announces each changed entry
// and the page merges it in.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentRegistry } from '../src/main/agent-registry'
import { mergeEntry } from '../src/renderer/src/agent-registry'
import type { AgentRegistryEntry } from '../src/renderer/src/agent-registry'

const registry = (): AgentRegistry => new AgentRegistry(path.join(mkdtempSync(path.join(tmpdir(), 'roster-')), 'agents.json'))
const spawn = { id: 'a1', name: 'Probe', preset: 'Claude Code', command: 'claude', role: null, cwd: '/w', workspaceId: 'ws1', workspaceName: 'Cookrew Dev', orch: false, sessionRef: null }

describe('the registry announces every change', () => {
  it('announces a spawn and a deactivation with the changed entry', () => {
    const r = registry()
    const seen: { id: string; active: boolean }[] = []
    r.onChange((e) => seen.push({ id: e.id, active: e.active }))
    r.upsert(spawn)
    r.deactivate('a1')
    expect(seen).toEqual([{ id: 'a1', active: true }, { id: 'a1', active: false }])
  })

  it('stays quiet for a deactivation that changes nothing, and stops after unsubscribe', () => {
    const r = registry()
    r.upsert(spawn)
    r.deactivate('a1')
    const seen: string[] = []
    const off = r.onChange((e) => seen.push(e.id))
    r.deactivate('a1')
    r.deactivate('nobody')
    off()
    r.upsert(spawn)
    expect(seen).toEqual([])
  })
})

describe('the page merges an announced entry into the roster it holds', () => {
  const entry = (over: Partial<AgentRegistryEntry>): AgentRegistryEntry =>
    ({ id: 'a1', name: 'Probe', preset: 'Claude Code', role: null, cwd: '/w', workspaceId: 'ws1', workspaceName: 'Cookrew Dev', spawnedAt: 1, orch: false, active: true, ...over }) as AgentRegistryEntry
  it('replaces a known entry in place', () => {
    const list = [entry({}), entry({ id: 'a2', name: 'Gauge' })]
    const next = mergeEntry(list, entry({ active: false }))
    expect(next.map((e) => [e.id, e.active])).toEqual([['a1', false], ['a2', true]])
    expect(list[0].active).toBe(true)
  })
  it('appends a new one', () => {
    expect(mergeEntry([entry({})], entry({ id: 'a3' })).map((e) => e.id)).toEqual(['a1', 'a3'])
  })
})
