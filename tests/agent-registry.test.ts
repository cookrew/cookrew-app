import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentRegistry, AgentRegistryUpsert } from '../src/main/agent-registry'

function entry(overrides: Partial<AgentRegistryUpsert> = {}): AgentRegistryUpsert {
  return {
    id: 'term-1',
    name: 'Coder',
    preset: 'Claude Code',
    command: 'claude --permission-mode bypassPermissions',
    role: null,
    cwd: '/work/alpha',
    workspaceId: 'ws-a',
    workspaceName: 'Alpha',
    orch: false,
    ...overrides
  }
}

function makeRegistry(): { registry: AgentRegistry; file: string } {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-agents-')), 'agents.json')
  return { registry: new AgentRegistry(file), file }
}

describe('AgentRegistry', () => {
  it('records a spawn as an active entry and persists it', () => {
    const { registry, file } = makeRegistry()
    const saved = registry.upsert(entry())
    expect(saved.active).toBe(true)
    expect(saved.spawnedAt).toBeGreaterThan(0)

    // Durable: a fresh instance on the same file sees it (reboot survival).
    const reloaded = new AgentRegistry(file)
    expect(reloaded.lookup('term-1')?.name).toBe('Coder')
    expect(reloaded.lookup('term-1')?.workspaceName).toBe('Alpha')
  })

  it('preserves spawnedAt across re-spawns but refreshes the rest', () => {
    const { registry } = makeRegistry()
    const first = registry.upsert(entry())
    const second = registry.upsert(entry({ name: 'Coder II', workspaceName: 'Beta', workspaceId: 'ws-b' }))
    expect(second.spawnedAt).toBe(first.spawnedAt)
    expect(second.name).toBe('Coder II')
    expect(second.workspaceId).toBe('ws-b')
    expect(registry.list()).toHaveLength(1)
  })

  it('marks agents inactive on deactivate and reactivates on next spawn', () => {
    const { registry, file } = makeRegistry()
    registry.upsert(entry())
    registry.deactivate('term-1')
    expect(registry.lookup('term-1')?.active).toBe(false)
    expect(new AgentRegistry(file).lookup('term-1')?.active).toBe(false)

    registry.upsert(entry())
    expect(registry.lookup('term-1')?.active).toBe(true)
  })

  it('ignores deactivate for unknown ids', () => {
    const { registry } = makeRegistry()
    expect(() => registry.deactivate('nope')).not.toThrow()
    expect(registry.list()).toHaveLength(0)
  })

  it('survives a corrupt registry file', () => {
    const { file } = makeRegistry()
    writeFileSync(file, '{not json', 'utf8')
    const registry = new AgentRegistry(file)
    expect(registry.list()).toEqual([])
    expect(registry.upsert(entry()).active).toBe(true)
  })
})

describe('sessionRef enrichment (R2 legacy-recover fix)', () => {
  it('persists sessionRef on upsert and updates it on setSessionRef', () => {
    const { registry, file } = makeRegistry()
    registry.upsert(entry({ sessionRef: 'claude-sess-1' }))
    expect(new AgentRegistry(file).lookup('term-1')?.sessionRef).toBe('claude-sess-1')

    // Lazy bind (codex/opencode) updates the ref later.
    registry.setSessionRef('term-1', '/x/rollout-uuid.jsonl')
    expect(new AgentRegistry(file).lookup('term-1')?.sessionRef).toBe('/x/rollout-uuid.jsonl')
    // No-op for unknown ids / unchanged refs.
    registry.setSessionRef('nope', 'x')
    expect(registry.lookup('nope')).toBeUndefined()
  })
})
