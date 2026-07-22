import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { orphanSessionNames, sessionNameFor } from '../src/main/pty'
import { WorkspaceStore } from '../src/main/store'
import { DEFAULT_TERMINAL_SIZE } from '../src/shared/model'

describe('orphanSessionNames', () => {
  const owned = ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'ffffffff-1111-2222-3333-444444444444']

  it('flags cookrew sessions that belong to no terminal node', () => {
    const ownedNames = owned.map(sessionNameFor)
    const orphan = sessionNameFor('99999999-8888-7777-6666-555555555555')
    expect(orphanSessionNames([...ownedNames, orphan], owned)).toEqual([orphan])
  })

  it('never returns an owned session', () => {
    const ownedNames = owned.map(sessionNameFor)
    expect(orphanSessionNames(ownedNames, owned)).toEqual([])
  })

  it('never touches a foreign (non-cookrew) tmux session', () => {
    const orphan = sessionNameFor('99999999-8888-7777-6666-555555555555')
    const foreign = ['0', 'my-editor', 'ssh-tunnel', 'cookrewX-not-ours']
    expect(orphanSessionNames([...foreign, orphan], owned)).toEqual([orphan])
  })

  it('returns nothing when there are no sessions', () => {
    expect(orphanSessionNames([], owned)).toEqual([])
  })
})

describe('WorkspaceStore terminal enumeration (delete-leak kill list)', () => {
  function freshStore(): WorkspaceStore {
    return new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'cookrew-del-')))
  }
  const term = (id: string, cwd: string): Parameters<WorkspaceStore['addNode']>[0] => ({
    kind: 'terminal',
    id,
    name: id,
    preset: 'Claude Code',
    command: 'claude',
    cwd,
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: DEFAULT_TERMINAL_SIZE
  })

  it('terminalIdsOf lists a workspace terminals — active AND after switching away', () => {
    const store = freshStore()
    const homeId = store.activeId
    store.addNode(term('t-home', store.state.dir))
    expect(store.terminalIdsOf(homeId)).toEqual(['t-home'])

    const other = store.createWorkspace('B', store.state.dir)
    store.switchWorkspace(other.id)
    store.addNode(term('t-b', store.state.dir))
    // The deleted-workspace kill list must reach the now-INACTIVE home too.
    expect(store.terminalIdsOf(homeId)).toEqual(['t-home'])
    expect(store.terminalIdsOf(other.id)).toEqual(['t-b'])
  })

  it('allTerminalIds spans every workspace (the reaper ownership set)', () => {
    const store = freshStore()
    store.addNode(term('t-home', store.state.dir))
    const other = store.createWorkspace('B', store.state.dir)
    store.switchWorkspace(other.id)
    store.addNode(term('t-b', store.state.dir))
    expect(new Set(store.allTerminalIds())).toEqual(new Set(['t-home', 't-b']))
  })

  it('allTerminalIdsStrict THROWS on a corrupt parked workspace.json (reaper aborts, fail-safe)', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-del-'))
    const store = new WorkspaceStore(base)
    store.addNode(term('t-home', store.state.dir))
    const parked = store.createWorkspace('Parked', store.state.dir)
    store.switchWorkspace(parked.id)
    store.addNode(term('t-parked', store.state.dir))
    store.switchWorkspace(store.list().workspaces[0].id)
    // Corrupt the PARKED workspace's file: lenient enumeration silently drops
    // its terminals (the fail-open bug), strict must throw so the reap aborts.
    writeFileSync(
      path.join(base, 'workspaces', parked.id, 'workspace.json'),
      '{"nodes": [truncated',
      'utf8'
    )
    expect(new Set(store.allTerminalIds())).toEqual(new Set(['t-home']))
    expect(() => store.allTerminalIdsStrict()).toThrow()
  })
})
