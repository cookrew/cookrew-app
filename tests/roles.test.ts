import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TerminalNodeData } from '../src/shared/model'
import { RoleStore, roleSlug } from '../src/main/roles'

function terminal(patch: Partial<TerminalNodeData> = {}): TerminalNodeData {
  return {
    kind: 'terminal',
    id: 't1',
    name: 'Forge',
    preset: 'Claude Code',
    command: 'claude --permission-mode bypassPermissions',
    cwd: '/work/repo',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    ...patch
  }
}

function makeStore(): RoleStore {
  return new RoleStore(mkdtempSync(path.join(tmpdir(), 'cookrew-roles-')))
}

describe('roleSlug', () => {
  it('produces filesystem-safe stems', () => {
    expect(roleSlug('Backend Dev (TDD)')).toBe('backend-dev-tdd')
    expect(roleSlug('  ')).toBe('role')
  })
})

describe('RoleStore', () => {
  it('saves and lists roles with the node preset/command snapshotted', () => {
    const store = makeStore()
    const saved = store.save(terminal(), 'Backend Dev', 'You are a backend developer.')
    expect(saved.preset).toBe('Claude Code')
    expect(saved.command).toContain('claude')
    const listed = store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0].name).toBe('Backend Dev')
    expect(listed[0].rolePrompt).toBe('You are a backend developer.')
  })

  it('looks roles up case-insensitively and deletes them', () => {
    const store = makeStore()
    store.save(terminal(), 'Reviewer', 'Review code.')
    expect(store.get('reviewer')?.name).toBe('Reviewer')
    expect(store.delete('REVIEWER')).toBe(true)
    expect(store.get('Reviewer')).toBeUndefined()
    expect(store.delete('Reviewer')).toBe(false)
  })

  it('overwrites when saving the same name again', () => {
    const store = makeStore()
    store.save(terminal(), 'Dev', 'v1 prompt')
    store.save(terminal({ preset: 'Codex', command: 'codex' }), 'Dev', 'v2 prompt')
    const listed = store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0].rolePrompt).toBe('v2 prompt')
    expect(listed[0].preset).toBe('Codex')
  })

  it('rejects empty names, empty prompts and plain shells', () => {
    const store = makeStore()
    expect(() => store.save(terminal(), '  ', 'p')).toThrow(/name/)
    expect(() => store.save(terminal(), 'Dev', '  ')).toThrow(/prompt/)
    expect(() => store.save(terminal({ command: '' }), 'Dev', 'p')).toThrow(/shell/)
  })
})

describe('role-from-checkpoint provenance (checkpoint-program-spec)', () => {
  it('persists sourceTurn uuid/prompt and session-copy ref through a reload', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-roles-ckpt-'))
    const store = new RoleStore(dir)
    store.save(terminal(), 'Reviewer', 'review all diffs', {
      sourceTurnUuid: 'u42',
      sourceTurnPrompt: 'review the phone companion diff',
      sessionCopyRef: 'reviewer-session.jsonl'
    })
    const loaded = new RoleStore(dir).get('Reviewer')
    expect(loaded?.sourceTurnUuid).toBe('u42')
    expect(loaded?.sourceTurnPrompt).toBe('review the phone companion diff')
    expect(loaded?.sessionCopyRef).toBe('reviewer-session.jsonl')
  })

  it('omits provenance fields entirely when saved without a checkpoint', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-roles-plain-'))
    const store = new RoleStore(dir)
    const role = store.save(terminal(), 'Plain', 'do things')
    expect('sourceTurnUuid' in role).toBe(false)
    expect('sessionCopyRef' in role).toBe(false)
  })
})
