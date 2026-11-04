// CLI verbs that read "the canvas" must read the CALLER's canvas, never the
// one the window happens to show.
//
// Owner ruling 2026-11-04: every workspace works on its own; switching what
// the window shows must not change what a command in another workspace sees
// or does. Each case below runs with the caller's workspace NOT on screen.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cmdConnect, cmdList, cmdOrch, cmdRole } from '../src/main/socket-server'
import type { SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import type { CliRequest, NoteNodeData, TerminalNodeData } from '../src/shared/model'

const terminal = (id: string, name: string, orch = false): TerminalNodeData => ({
  kind: 'terminal', id, name, preset: 'Claude Code', command: 'claude', cwd: '/tmp',
  orch, role: null, position: { x: 0, y: 0 }, size: { width: 640, height: 420 }
})
const note = (id: string, name: string): NoteNodeData =>
  ({ kind: 'note', id, name, content: '', position: { x: 0, y: 0 }, size: { width: 300, height: 200 } }) as NoteNodeData
const request = (cmd: string, args: string[], terminalId: string, flags: CliRequest['flags'] = {}): CliRequest =>
  ({ id: 'r1', cmd, args, flags, terminalId })

/** The caller ("Conductor", the GOAT orch) lives in GOAT; Cookrew is on screen. */
function setup() {
  const store = new WorkspaceStore(
    path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-focus-free-')), 'data'),
    { multiInstance: true }
  )
  const goat = store.focusedId
  store.renameWorkspace(goat, 'GOAT')
  const me = store.addNode(terminal('t-orch', 'Conductor', true)) as TerminalNodeData
  const shots = store.addNode(terminal('t-shots', 'D1-Shots')) as TerminalNodeData
  const plan = store.addNode(note('n-plan', 'Plan')) as NoteNodeData
  store.connect(shots.id, plan.id)
  const cookrew = store.createWorkspace('Cookrew', '/tmp').id
  store.switchWorkspace(cookrew)
  store.addNode(terminal('t-other', 'D1-Shots'))
  const roleSave = vi.fn((input: { nodeId: string; name: string }) => ({ name: input.name, preset: 'Claude Code', rolePrompt: 'x' }))
  const deps = {
    store,
    roleSave,
    listWorkspaces: () => store.list(),
    isServed: () => false,
    agents: { list: () => [], lookup: () => undefined }
  } as unknown as SocketServerDeps
  return { store, deps, roleSave, me, shots, plan, goat, cookrew }
}

describe('verbs read the caller\'s canvas while another is on screen', () => {
  it('list --workspace shows who each card is wired to', () => {
    const { deps, me } = setup()
    const out = cmdList(request('list', [], me.id, { workspace: true }), deps)
    expect(out).toMatch(/"Plan".*wired to: D1-Shots/)
  })

  it('connect finds an unwired card of the caller\'s own canvas by name', () => {
    const { store, deps, me, shots, plan, goat } = setup()
    expect(cmdConnect(request('connect', ['Conductor', 'Plan'], me.id), deps)).toMatch(/Connected/)
    const conns = store.workspaceState(goat).connections
    expect(conns.some((c) => (c.a === me.id && c.b === plan.id) || (c.a === plan.id && c.b === me.id))).toBe(true)
    void shots
  })

  it('orch promotes the named agent of the caller\'s workspace, not a same-named one on screen', () => {
    const { store, deps, me, shots, goat } = setup()
    cmdOrch(request('orch', ['D1-Shots'], me.id), deps)
    const promoted = store.workspaceState(goat).nodes.find((n) => n.id === shots.id) as TerminalNodeData
    expect(promoted.orch).toBe(true)
  })

  it('role save reads the caller\'s workspace agent', () => {
    const { deps, roleSave, me, shots } = setup()
    cmdRole(request('role', ['save', 'D1-Shots', 'Shooter'], me.id, { prompt: 'take shots' }), deps)
    expect(roleSave).toHaveBeenCalledWith(expect.objectContaining({ nodeId: shots.id }))
  })
})
