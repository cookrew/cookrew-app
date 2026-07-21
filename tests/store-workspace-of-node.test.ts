import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import { DEFAULT_TERMINAL_SIZE } from '../src/shared/model'

function freshStore(): WorkspaceStore {
  return new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'cookrew-ws-')))
}

describe('WorkspaceStore.workspaceOfNode', () => {
  it('finds a node in the ACTIVE workspace (returns the active meta)', () => {
    const store = freshStore()
    const node = store.addNode({
      kind: 'terminal',
      id: 'term-a',
      name: 'A',
      preset: 'Shell',
      command: '',
      cwd: store.state.dir,
      orch: false,
      role: null,
      position: { x: 0, y: 0 },
      size: DEFAULT_TERMINAL_SIZE
    })
    const home = store.workspaceOfNode(node.id)
    expect(home?.id).toBe(store.activeId)
  })

  it('finds a node that lives in an INACTIVE workspace after switching away', () => {
    const store = freshStore()
    const homeId = store.activeId
    const homeName = store.activeMeta().name
    store.addNode({
      kind: 'terminal',
      id: 'term-home',
      name: 'HomeAgent',
      preset: 'Shell',
      command: '',
      cwd: store.state.dir,
      orch: true,
      role: null,
      position: { x: 0, y: 0 },
      size: DEFAULT_TERMINAL_SIZE
    })
    const other = store.createWorkspace('Bravo', store.state.dir)
    store.switchWorkspace(other.id)

    expect(store.node('term-home')).toBeUndefined() // active-scoped: gone
    const home = store.workspaceOfNode('term-home')
    expect(home?.id).toBe(homeId)
    expect(home?.name).toBe(homeName)
    expect(store.activeId).toBe(other.id)
  })

  it('returns undefined for a node that exists in no workspace', () => {
    const store = freshStore()
    expect(store.workspaceOfNode('ghost')).toBeUndefined()
  })
})
