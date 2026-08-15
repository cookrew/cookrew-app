import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_HOT_WORKSPACES, WorkspaceStore } from '../src/main/store'

function freshStore(): { base: string; store: WorkspaceStore } {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-service-state-'))
  return { base, store: new WorkspaceStore(base) }
}

describe('workspace service state', () => {
  it('seeds the focused workspace hot and creates other workspaces dormant', () => {
    const { store } = freshStore()
    const home = store.activeMeta()
    const other = store.createWorkspace('Other', '/work/other')

    expect(home.serviceState).toBe('hot')
    expect(other.serviceState).toBe('dormant')
  })

  it('persists explicit transitions and focus switches do not change them', () => {
    const { base, store } = freshStore()
    const homeId = store.activeId
    const other = store.createWorkspace('Other', '/work/other')
    store.setWorkspaceServiceState(other.id, 'hot')
    store.setWorkspaceServiceState(homeId, 'parked')
    store.switchWorkspace(other.id)

    const reopened = new WorkspaceStore(base)
    const byId = new Map(reopened.list().workspaces.map((workspace) => [workspace.id, workspace]))
    expect(reopened.activeId).toBe(other.id)
    expect(byId.get(other.id)?.serviceState).toBe('hot')
    expect(byId.get(homeId)?.serviceState).toBe('parked')
  })

  it('emits a scoped transition for lifecycle coordinators', () => {
    const { store } = freshStore()
    const other = store.createWorkspace('Service', '/work/service')
    const events: unknown[] = []
    store.on('service', (event) => events.push(event))

    store.setWorkspaceServiceState(other.id, 'hot')

    expect(events).toEqual([
      { workspaceId: other.id, previous: 'dormant', serviceState: 'hot' }
    ])
  })

  it('bounds explicit hot lanes and leaves newly created workspaces dormant', () => {
    const { store } = freshStore()
    const created = Array.from({ length: MAX_HOT_WORKSPACES }, (_, index) =>
      store.createWorkspace(`Service ${index + 1}`, `/work/service-${index + 1}`)
    )
    expect(created.every((workspace) => workspace.serviceState === 'dormant')).toBe(true)

    // The seeded focused workspace already owns one of the bounded lanes.
    for (const workspace of created.slice(0, MAX_HOT_WORKSPACES - 1)) {
      store.setWorkspaceServiceState(workspace.id, 'hot')
    }
    expect(() => store.setWorkspaceServiceState(created.at(-1)!.id, 'hot')).toThrow(
      `HOT workspace capacity reached (${MAX_HOT_WORKSPACES})`
    )
    expect(store.list().workspaces.filter((workspace) => workspace.serviceState === 'hot')).toHaveLength(
      MAX_HOT_WORKSPACES
    )
  })

  it('caps a legacy all-hot registry on load and preserves the focused lane', () => {
    const { base, store } = freshStore()
    const extras = Array.from({ length: MAX_HOT_WORKSPACES + 2 }, (_, index) =>
      store.createWorkspace(`Legacy Hot ${index + 1}`, `/work/hot-${index + 1}`)
    )
    const focused = extras.at(-1)!
    store.switchWorkspace(focused.id)
    const registryFile = path.join(base, 'registry.json')
    const registry = JSON.parse(readFileSync(registryFile, 'utf8')) as {
      activeId: string
      workspaces: Array<Record<string, unknown>>
    }
    for (const workspace of registry.workspaces) workspace.serviceState = 'hot'
    writeFileSync(registryFile, JSON.stringify(registry, null, 2), 'utf8')

    const reopened = new WorkspaceStore(base)
    const hot = reopened.list().workspaces.filter((workspace) => workspace.serviceState === 'hot')
    expect(hot).toHaveLength(MAX_HOT_WORKSPACES)
    expect(hot.some((workspace) => workspace.id === focused.id)).toBe(true)
  })

  it('normalizes legacy metas to active hot and inactive dormant', () => {
    const { base, store } = freshStore()
    const other = store.createWorkspace('Legacy Other', '/work/other')
    const registryFile = path.join(base, 'registry.json')
    const registry = JSON.parse(readFileSync(registryFile, 'utf8')) as {
      activeId: string
      workspaces: Array<Record<string, unknown>>
    }
    for (const workspace of registry.workspaces) delete workspace.serviceState
    writeFileSync(registryFile, JSON.stringify(registry, null, 2), 'utf8')

    const reopened = new WorkspaceStore(base)
    const byId = new Map(reopened.list().workspaces.map((workspace) => [workspace.id, workspace]))
    expect(byId.get(registry.activeId)?.serviceState).toBe('hot')
    expect(byId.get(other.id)?.serviceState).toBe('dormant')
  })

  it('persists internal binding updates in an inactive workspace without changing focus', () => {
    const { store } = freshStore()
    const activeId = store.activeId
    const other = store.createWorkspaceWithState(
      'Background',
      '/work/background',
      [
        {
          kind: 'terminal',
          id: 'detached-agent',
          name: 'Detached',
          preset: 'claude',
          command: 'claude',
          cwd: '/work/background',
          orch: false,
          role: null,
          position: { x: 0, y: 0 },
          size: { width: 640, height: 420 }
        }
      ],
      []
    )

    store.updateNodeAcrossWorkspacesUnsafe('detached-agent', { claudeSessionId: 'session-1' })

    expect(store.activeId).toBe(activeId)
    expect(store.workspaceState(other.id).nodes[0]).toMatchObject({
      id: 'detached-agent',
      claudeSessionId: 'session-1'
    })
  })
})
