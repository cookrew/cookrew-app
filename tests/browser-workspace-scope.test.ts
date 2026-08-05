// `cookrew browser ...` vs the workspace a node lives in.
//
// The reported closed loop: `cookrew list` enumerates a caller's connections
// ACROSS all workspaces, but a browser is driven through a webview (or headless
// instance) belonging to the ACTIVE workspace only. list advertised a browser,
// the engine answered "not found. Run 'cookrew list'", and an agent bounced
// between the two forever. These pin the composed behaviour — the pure message
// helper can be right while the wiring around it still loops.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cmdBrowser } from '../src/main/socket-server'
import type { SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import type { BrowserNodeData, CliRequest, TerminalNodeData } from '../src/shared/model'

function terminal(id: string, name: string): TerminalNodeData {
  return {
    kind: 'terminal', id, name, preset: 'Claude Code', command: 'claude', cwd: '/tmp',
    orch: true, role: null, position: { x: 10, y: 20 }, size: { width: 640, height: 420 }
  }
}

function browser(id: string, name: string): BrowserNodeData {
  return {
    kind: 'browser', id, name, url: 'https://example.test',
    position: { x: 700, y: 20 }, size: { width: 720, height: 560 }
  }
}

function request(args: string[], terminalId: string): CliRequest {
  return { id: 'r1', cmd: 'browser', args, flags: {}, terminalId }
}

/** Two workspaces: "Home" (where the caller lives) and "Other". */
function setup(): {
  store: WorkspaceStore
  deps: SocketServerDeps
  browserCommand: ReturnType<typeof vi.fn>
  home: string
  other: string
} {
  const store = new WorkspaceStore(
    path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-browser-scope-')), 'data')
  )
  const home = store.activeId
  store.renameWorkspace(home, 'Home')
  const other = store.createWorkspace('Other', '/tmp').id
  const browserCommand = vi.fn(() => Promise.resolve('delegated'))
  const deps = {
    store,
    browserCommand,
    listWorkspaces: () => store.list()
  } as unknown as SocketServerDeps
  return { store, deps, browserCommand, home, other }
}

describe('cmdBrowser — workspace scope', () => {
  it('names the browser\'s own workspace instead of sending the agent back to list', async () => {
    const { store, deps, browserCommand, home, other } = setup()
    const me = store.addNode(terminal('t1', 'Conductor')) as TerminalNodeData
    store.switchWorkspace(other)
    const parked = store.addNode(browser('b1', '巴法云')) as BrowserNodeData
    store.switchWorkspace(home)
    store.connectAcross(me.id, parked.id)

    // The caller and the browser are both in the (now inactive) other side of
    // the edge — exactly the reported state.
    store.switchWorkspace(home)
    await expect(cmdBrowser(request(['info', '巴法云'], me.id), deps)).rejects.toThrow(/Other/)
    await expect(cmdBrowser(request(['info', '巴法云'], me.id), deps)).rejects.toThrow(
      /workspace switch/
    )
    expect(browserCommand).not.toHaveBeenCalled()
  })

  it('drives a LOCAL browser even when the caller is parked elsewhere', async () => {
    // Finding from review: gating on the caller regressed a working flow and
    // created a switch↔switch loop. Driving needs the browser, not the caller.
    const { store, deps, browserCommand, home, other } = setup()
    store.switchWorkspace(other)
    const me = store.addNode(terminal('t1', 'Conductor')) as TerminalNodeData
    store.switchWorkspace(home)
    store.addNode(browser('b1', 'Docs'))

    await expect(cmdBrowser(request(['info', 'Docs'], me.id), deps)).resolves.toBe('delegated')
    expect(browserCommand).toHaveBeenCalledWith(['info', 'Docs'], me.id)
  })

  it('prefers a local browser over a same-named one parked elsewhere', async () => {
    // Default names collide easily (`cookrew browser create URL` yields
    // "Browser"), and the cross-workspace edge list is not active-first — so
    // resolving remotely first could refuse a name that works right here.
    const { store, deps, browserCommand, home, other } = setup()
    const me = store.addNode(terminal('t1', 'Conductor')) as TerminalNodeData
    store.switchWorkspace(other)
    const remote = store.addNode(browser('b-remote', 'Browser')) as BrowserNodeData
    store.switchWorkspace(home)
    store.connectAcross(me.id, remote.id)
    store.addNode(browser('b-local', 'Browser'))

    await expect(cmdBrowser(request(['snapshot', 'Browser'], me.id), deps)).resolves.toBe('delegated')
    expect(browserCommand).toHaveBeenCalled()
  })

  it('refuses create from a caller parked in another workspace', async () => {
    // The original report: the node landed in the ACTIVE workspace at (0,0)
    // with an edge to an id that workspace does not hold.
    const { store, deps, browserCommand, home, other } = setup()
    store.switchWorkspace(other)
    const me = store.addNode(terminal('t1', 'Conductor')) as TerminalNodeData
    store.switchWorkspace(home)

    await expect(
      cmdBrowser(request(['create', 'https://example.test', 'X'], me.id), deps)
    ).rejects.toThrow(/Other/)
    expect(browserCommand).not.toHaveBeenCalled()
  })

  it('delegates create for a caller in the active workspace', async () => {
    const { store, deps, browserCommand } = setup()
    const me = store.addNode(terminal('t1', 'Conductor')) as TerminalNodeData
    await expect(
      cmdBrowser(request(['create', 'https://example.test', 'X'], me.id), deps)
    ).resolves.toBe('delegated')
    expect(browserCommand).toHaveBeenCalledOnce()
  })

  it('delegates an unknown browser name so the engine owns that error', async () => {
    const { store, deps, browserCommand } = setup()
    const me = store.addNode(terminal('t1', 'Conductor')) as TerminalNodeData
    await expect(cmdBrowser(request(['info', 'Nope'], me.id), deps)).resolves.toBe('delegated')
    expect(browserCommand).toHaveBeenCalled()
  })
})
