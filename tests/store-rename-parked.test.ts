// BOX ROUND 3, BUG 3. Renaming a workspace you are not in changed the registry
// and left workspace.json, and so the crew header, on the old name through a
// relaunch. The registry is the name; the file follows it.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import type { WorkspaceState } from '../src/shared/model'

const fresh = (multi: boolean): WorkspaceStore =>
  new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'cookrew-rename-')), { multiInstance: multi })

const fileOf = (store: WorkspaceStore, id: string): string =>
  path.join(store.baseDirForTests, 'workspaces', id, 'workspace.json')

const onDisk = (store: WorkspaceStore, id: string): WorkspaceState =>
  JSON.parse(readFileSync(fileOf(store, id), 'utf8')) as WorkspaceState

function parkedWorkspace(): { store: WorkspaceStore; id: string } {
  const store = fresh(false)
  const home = store.list().activeId
  const id = store.createWorkspace('Phone One', tmpdir()).id
  expect(store.isResident(id)).toBe(false)
  return { store, id }
}

describe('renaming a workspace nobody is in', () => {
  it('writes the new name into its workspace.json at once', () => {
    const { store, id } = parkedWorkspace()
    store.renameWorkspace(id, 'Phone Renamed')
    expect(onDisk(store, id).name).toBe('Phone Renamed')
  })

  it('reads the new name for a parked reader', () => {
    const { store, id } = parkedWorkspace()
    store.workspaceState(id)
    store.renameWorkspace(id, 'Phone Renamed')
    expect(store.workspaceState(id).name).toBe('Phone Renamed')
  })

  it('opens under the new name, and a relaunch keeps it', () => {
    const { store, id } = parkedWorkspace()
    store.renameWorkspace(id, 'Phone Renamed')
    store.switchWorkspace(id)
    expect(store.focusedState.name).toBe('Phone Renamed')
    store.flush()
    const relaunched = new WorkspaceStore(store.baseDirForTests, { multiInstance: false })
    expect(relaunched.focusedState.name).toBe('Phone Renamed')
  })

  it('says the workspace changed, for a phone reading it', () => {
    const { store, id } = parkedWorkspace()
    const seen: string[] = []
    store.on('workspace-change', (change: { workspaceId: string; state: WorkspaceState }) => {
      seen.push(`${change.workspaceId}:${change.state.name}`)
    })
    store.renameWorkspace(id, 'Phone Renamed')
    expect(seen).toEqual([`${id}:Phone Renamed`])
  })
})

describe('renaming a workspace held in memory, not on screen', () => {
  it('reaches its file without waiting for a quit', () => {
    vi.useFakeTimers()
    try {
      const store = fresh(true)
      const home = store.list().activeId
      const id = store.createWorkspace('Held', tmpdir()).id
      store.switchWorkspace(id)
      store.switchWorkspace(home)
      expect(store.isResident(id)).toBe(true)
      store.renameWorkspace(id, 'Held Renamed')
      vi.advanceTimersByTime(1000)
      expect(onDisk(store, id).name).toBe('Held Renamed')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a workspace already renamed by the old build', () => {
  const staleFile = (): { store: WorkspaceStore; id: string } => {
    const { store, id } = parkedWorkspace()
    store.renameWorkspace(id, 'Registry Name')
    writeFileSync(fileOf(store, id), JSON.stringify({ ...onDisk(store, id), name: 'Stale Name' }), 'utf8')
    return { store: new WorkspaceStore(store.baseDirForTests, { multiInstance: false }), id }
  }

  it('heals on open: the header reads the registry, and the next flush fixes the file', () => {
    const { store, id } = staleFile()
    store.switchWorkspace(id)
    expect(store.focusedState.name).toBe('Registry Name')
    store.flush()
    expect(onDisk(store, id).name).toBe('Registry Name')
  })

  it('reads the registry’s name while parked too', () => {
    const { store, id } = staleFile()
    expect(store.workspaceState(id).name).toBe('Registry Name')
  })
})
