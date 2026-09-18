// `cookrew note create` vs the workspace the caller lives in.
//
// Reported by the owner, 2026-09-18, with a screenshot: they switched to
// Playground to do something else, and every card the v3 agents made from
// their Cookrew Dev terminals appeared THERE — joined to their terminal by an
// edge that spanned two workspaces. Reads and writes by name then resolved to
// whichever copy the caller happened to find, which is why a `note write`
// could answer OK while the next `note read` showed the old text: they were
// two different notes on two different canvases.
//
// The rule these pin: a node made on behalf of another node belongs to THAT
// node's workspace. The focused one is for what a person does by hand.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cmdNote } from '../src/main/socket-server'
import type { SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import type { CliRequest, TerminalNodeData } from '../src/shared/model'

function terminal(id: string, name: string): TerminalNodeData {
  return {
    kind: 'terminal', id, name, preset: 'Claude Code', command: 'claude', cwd: '/tmp',
    orch: true, role: null, position: { x: 10, y: 20 }, size: { width: 640, height: 420 }
  }
}

function request(args: string[], terminalId: string): CliRequest {
  return { id: 'r1', cmd: 'note', args, flags: {}, terminalId }
}

function setup(): { store: WorkspaceStore; deps: SocketServerDeps; home: string; other: string } {
  const store = new WorkspaceStore(
    path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-note-scope-')), 'data')
  )
  const home = store.focusedId
  store.renameWorkspace(home, 'Cookrew Dev')
  const other = store.createWorkspace('Playground', '/tmp').id
  const deps = { store, listWorkspaces: () => store.list() } as unknown as SocketServerDeps
  return { store, deps, home, other }
}

describe('cmdNote create — workspace scope', () => {
  it('puts the card on the CALLER’S canvas while the owner is looking elsewhere', () => {
    const { store, deps, home, other } = setup()
    const me = store.addNode(terminal('t1', 'Velvet')) as TerminalNodeData
    // The owner switches to Playground to do something else.
    store.switchWorkspace(other)
    cmdNote(request(['create', '# V3-21 per-device LAN token'], me.id), deps)
    const noteIn = (ws: string): boolean =>
      store.workspaceState(ws).nodes.some((n) => n.kind === 'note')
    expect(noteIn(home)).toBe(true)
    expect(noteIn(other)).toBe(false)
  })

  it('leaves the edge inside one workspace, so a later read finds the same note', () => {
    const { store, deps, other } = setup()
    const me = store.addNode(terminal('t1', 'Velvet')) as TerminalNodeData
    store.switchWorkspace(other)
    cmdNote(request(['create', '# the report'], me.id), deps)
    const note = store.workspaceState(store.ownerOf(me.id)!).nodes.find((n) => n.kind === 'note')!
    // The edge lives inside ONE workspace now, which is what makes a later
    // read find the same note instead of a same-named copy on another canvas.
    expect(store.workspaceState(store.ownerOf(me.id)!).connections.some(
      (c) => (c.a === me.id && c.b === note.id) || (c.b === me.id && c.a === note.id)
    )).toBe(true)
    // The read is by name through the same connection the create made.
    expect(cmdNote(request(['read', note.name], me.id), deps)).toContain('the report')
  })

  it('a card a PERSON makes still lands where they are looking', () => {
    const { store, other } = setup()
    store.switchWorkspace(other)
    const byHand = store.createNote({
      customName: null, content: '# by hand', locked: false,
      position: { x: 0, y: 0 }, size: { width: 320, height: 200 }
    })
    expect(store.ownerOf(byHand.id)).toBe(other)
  })
})
