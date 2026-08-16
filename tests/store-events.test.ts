import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import type { CookrewEvent } from '../src/main/event-log'
import type { TerminalNodeData } from '../src/shared/model'

function terminal(name: string, cwd = '/work/alpha'): TerminalNodeData {
  return {
    kind: 'terminal',
    id: `id-${name.toLowerCase()}-${Math.floor(Math.random() * 1e9)}`,
    name,
    preset: 'Claude Code',
    command: 'claude',
    cwd,
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 }
  }
}

function makeStore(): { store: WorkspaceStore; events: CookrewEvent[] } {
  const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'cookrew-ev-')))
  const events: CookrewEvent[] = []
  store.on('op', (e: CookrewEvent) => events.push(e))
  return { store, events }
}

describe('WorkspaceStore op choke-point (observability event log)', () => {
  it('emits terminal.created with workspace + actor metadata on addNode', () => {
    const { store, events } = makeStore()
    const node = store.addNode(terminal('Coder'))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'terminal.created',
      entityId: node.id,
      entityName: 'Coder',
      workspaceId: store.activeId,
      actor: 'user',
      details: 'Claude Code'
    })
    expect(events[0].timestamp).toBeGreaterThan(0)
  })

  it('refines the type and actor through withOpContext (orch recruit)', () => {
    const { store, events } = makeStore()
    store.withOpContext({ actor: 'orch', via: 'recruit' }, () => store.addNode(terminal('Sous')))
    expect(events[0].type).toBe('terminal.recruited')
    expect(events[0].actor).toBe('orch')
    // Context is scoped: a later plain add is a user-created terminal again.
    store.addNode(terminal('Plain'))
    expect(events[1].type).toBe('terminal.created')
    expect(events[1].actor).toBe('user')
  })

  it('labels cross-workspace adds with the TARGET workspace', () => {
    const { store, events } = makeStore()
    const beta = store.createWorkspace('Beta', '/work/beta')
    events.length = 0
    store.addNodeToWorkspace(beta.id, terminal('Remote', '/work/beta'))
    expect(events[0]).toMatchObject({
      type: 'terminal.created',
      workspaceId: beta.id,
      workspaceName: 'Beta'
    })
  })

  it('emits dismissed vs killed per context on removal', () => {
    const { store, events } = makeStore()
    const a = store.addNode(terminal('A'))
    const b = store.addNode(terminal('B'))
    events.length = 0
    store.withOpContext({ via: 'dismiss' }, () => store.removeNodeAcross(a.id))
    store.removeNode(b.id)
    expect(events.map((e) => e.type)).toEqual(['terminal.dismissed', 'terminal.killed'])
  })

  it('emits exactly ONE connection.made per logical cross-workspace edge', () => {
    const { store, events } = makeStore()
    const orch = store.addNode(terminal('Conductor'))
    const beta = store.createWorkspace('Beta', '/work/beta')
    const remote = store.addNodeToWorkspace(beta.id, terminal('Remote', '/work/beta'))
    events.length = 0
    store.connectAcross(orch.id, remote.id)
    store.connectAcross(orch.id, remote.id) // idempotent reconnect
    const made = events.filter((e) => e.type === 'connection.made')
    expect(made).toHaveLength(1)
    expect(made[0].entityName).toContain('Conductor')
    expect(made[0].entityName).toContain('Remote')
  })

  it('emits workspace lifecycle events', () => {
    const { store, events } = makeStore()
    const beta = store.createWorkspace('Beta', '/work/beta')
    store.switchWorkspace(beta.id)
    store.renameWorkspace(beta.id, 'Beta 2')
    expect(events.map((e) => e.type)).toEqual([
      'workspace.created',
      'workspace.switched',
      'workspace.renamed'
    ])
  })

  it('routes external ops (role/team saves) through the same choke-point', () => {
    const { store, events } = makeStore()
    store.recordEvent('role.saved', 'role-1', 'Reviewer', 'Claude Code')
    expect(events[0]).toMatchObject({ type: 'role.saved', entityName: 'Reviewer' })
    expect(events[0].workspaceId).toBe(store.activeId)
  })
})
