// The owner's one-line brief about a workspace: validated in one shared place,
// persisted in the registry beside the name and icon.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import { BRIEF_MAX, checkBrief } from '../src/shared/workspace-brief'

const bases: string[] = []
afterEach(() => {
  bases.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

function base(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-brief-'))
  bases.push(dir)
  return dir
}

describe('checkBrief', () => {
  it('trims and collapses newlines and runs of space into one line', () => {
    expect(checkBrief('  Recipes for\n\nthe   family\r\n ')).toEqual({ ok: true, brief: 'Recipes for the family' })
    expect(checkBrief('tab\there\u0000and\u0007there')).toEqual({ ok: true, brief: 'tab here and there' })
  })

  it('reads an empty or blank brief as unset', () => {
    expect(checkBrief('')).toEqual({ ok: true, brief: '' })
    expect(checkBrief(' \n ')).toEqual({ ok: true, brief: '' })
  })

  it('takes BRIEF_MAX characters and refuses one more', () => {
    expect(BRIEF_MAX).toBe(140)
    expect(checkBrief('x'.repeat(BRIEF_MAX))).toEqual({ ok: true, brief: 'x'.repeat(BRIEF_MAX) })
    expect(checkBrief('x'.repeat(BRIEF_MAX + 1)).ok).toBe(false)
    // Counted after collapsing: padding does not push it over.
    expect(checkBrief(`  ${'x'.repeat(BRIEF_MAX)}\n\n`).ok).toBe(true)
  })

  it('refuses anything but a string', () => {
    for (const raw of [undefined, null, 42, ['a'], { brief: 'a' }]) expect(checkBrief(raw).ok).toBe(false)
  })
})

describe('WorkspaceStore.setWorkspaceBrief', () => {
  it('persists the brief in the registry, announces the list, and survives a reload', () => {
    const dir = base()
    const store = new WorkspaceStore(dir)
    const id = store.focusedId
    const lists: unknown[] = []
    store.on('workspaces', (list) => lists.push(list))
    store.setWorkspaceBrief(id, '  Our  family\nhomelab ')
    expect(store.list().workspaces.find((w) => w.id === id)?.brief).toBe('Our family homelab')
    expect(lists).toHaveLength(1)
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'registry.json'), 'utf8')) as { workspaces: Array<{ brief?: string }> }
    expect(onDisk.workspaces[0].brief).toBe('Our family homelab')
    expect(new WorkspaceStore(dir).list().workspaces[0].brief).toBe('Our family homelab')
  })

  it('clears it with an empty brief, and an unchanged brief is no event', () => {
    const store = new WorkspaceStore(base())
    const id = store.focusedId
    store.setWorkspaceBrief(id, 'A demo')
    const lists: unknown[] = []
    store.on('workspaces', (list) => lists.push(list))
    store.setWorkspaceBrief(id, ' A demo ')
    expect(lists).toHaveLength(0)
    store.setWorkspaceBrief(id, '   ')
    expect('brief' in store.list().workspaces[0]).toBe(false)
    expect(lists).toHaveLength(1)
  })

  it('refuses an invalid brief or an unknown workspace and changes nothing', () => {
    const store = new WorkspaceStore(base())
    const id = store.focusedId
    store.setWorkspaceBrief(id, 'kept')
    expect(() => store.setWorkspaceBrief(id, 'x'.repeat(BRIEF_MAX + 1))).toThrow(/at most 140/)
    expect(() => store.setWorkspaceBrief(id, 7)).toThrow()
    expect(() => store.setWorkspaceBrief('nope', 'hello')).toThrow(/not found/)
    expect(store.list().workspaces[0].brief).toBe('kept')
  })

  it('drops a hand-edited invalid brief at load', () => {
    const dir = base()
    const id = new WorkspaceStore(dir).focusedId
    const file = path.join(dir, 'registry.json')
    const registry = JSON.parse(readFileSync(file, 'utf8')) as { workspaces: Array<Record<string, unknown>> }
    const edited = { ...registry, workspaces: registry.workspaces.map((w) => ({ ...w, brief: { not: 'text' } })) }
    writeFileSync(file, JSON.stringify(edited), 'utf8')
    const meta = new WorkspaceStore(dir).list().workspaces.find((w) => w.id === id)
    expect(meta && 'brief' in meta).toBe(false)
  })
})
