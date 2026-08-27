import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { orphanSessionNames, sessionNameFor } from '../src/main/pty'
import { WorkspaceStore } from '../src/main/store'
import { DEFAULT_BROWSER_SIZE, DEFAULT_TERMINAL_SIZE } from '../src/shared/model'

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
  const browser = (id: string): Parameters<WorkspaceStore['addNode']>[0] => ({
    kind: 'browser',
    id,
    name: id,
    url: 'about:blank',
    position: { x: 0, y: 0 },
    size: DEFAULT_BROWSER_SIZE
  })

  it('terminalIdsOf lists a workspace terminals — active AND after switching away', () => {
    const store = freshStore()
    const homeId = store.focusedId
    store.addNode(term('t-home', store.focusedState.dir))
    expect(store.terminalIdsOf(homeId)).toEqual(['t-home'])

    const other = store.createWorkspace('B', store.focusedState.dir)
    store.switchWorkspace(other.id)
    store.addNode(term('t-b', store.focusedState.dir))
    // The deleted-workspace kill list must reach the now-INACTIVE home too.
    expect(store.terminalIdsOf(homeId)).toEqual(['t-home'])
    expect(store.terminalIdsOf(other.id)).toEqual(['t-b'])
  })

  it('allTerminalIds spans every workspace (the reaper ownership set)', () => {
    const store = freshStore()
    store.addNode(term('t-home', store.focusedState.dir))
    const other = store.createWorkspace('B', store.focusedState.dir)
    store.switchWorkspace(other.id)
    store.addNode(term('t-b', store.focusedState.dir))
    expect(new Set(store.allTerminalIds())).toEqual(new Set(['t-home', 't-b']))
  })

  it('allBrowserIdsStrict spans every workspace', () => {
    const store = freshStore()
    store.addNode(browser('b-home'))
    const other = store.createWorkspace('B', store.focusedState.dir)
    store.switchWorkspace(other.id)
    store.addNode(browser('b-other'))
    expect(new Set(store.allBrowserIdsStrict())).toEqual(new Set(['b-home', 'b-other']))
  })

  it('allTerminalIdsStrict THROWS on a corrupt parked workspace.json (reaper aborts, fail-safe)', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-del-'))
    // multiInstance OFF is what makes 'parked' mean 'on disk only' — the
    // premise this test needs. With sessions resident the file is never read,
    // which the companion test below covers.
    const store = new WorkspaceStore(base, { multiInstance: false })
    store.addNode(term('t-home', store.focusedState.dir))
    const parked = store.createWorkspace('Parked', store.focusedState.dir)
    store.switchWorkspace(parked.id)
    store.addNode(term('t-parked', store.focusedState.dir))
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
    expect(() => store.allBrowserIdsStrict()).toThrow()
  })

  it('a RESIDENT workspace is enumerated from memory, corrupt file or not', () => {
    // Multi-instance makes the fail-safe stronger rather than weaker: the
    // store is the writer, so a resident session's state is never staler than
    // its file. A corrupt file is then not a reason to abort the reap — the
    // terminals are known, so they are claimed and cannot be killed as
    // unowned. The strict variant only has to fail-safe over what it must read.
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-del-'))
    const store = new WorkspaceStore(base, { multiInstance: true })
    store.addNode(term('t-home', store.focusedState.dir))
    const other = store.createWorkspace('Resident', store.focusedState.dir)
    store.switchWorkspace(other.id)
    store.addNode(term('t-resident', store.focusedState.dir))
    store.switchWorkspace(store.list().workspaces[0].id)
    expect(store.resident()).toContain(other.id)

    writeFileSync(
      path.join(base, 'workspaces', other.id, 'workspace.json'),
      '{"nodes": [truncated',
      'utf8'
    )
    expect(new Set(store.allTerminalIds())).toEqual(new Set(['t-home', 't-resident']))
    expect(() => store.allTerminalIdsStrict()).not.toThrow()
  })
})
