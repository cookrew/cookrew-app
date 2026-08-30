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
  const home = store.focusedId
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

  // Probe's P0, 2026-08-30. ac57f2b repaired WHO the caller is, but cmdBrowser
  // went on handing browserCommand the raw env id, so create() looked up a
  // terminal that is not a node here, anchored nothing, wrote no edge, and
  // reported "not connected" — the caller's own card, disowned by its caller.
  // The repair has to reach the delegate, not just the guard above it.
  it('delegates the REPAIRED caller id, not the env id it was spawned under', async () => {
    const { store, deps, browserCommand, home, other } = setup()
    // The host pane the background agent inherited its environment from — a
    // real terminal, in a different workspace.
    store.switchWorkspace(other)
    store.addNode(terminal('host-pane', 'GOAT Conductor'))
    // The agent's OWN card, in the focused workspace, bound to its session.
    store.switchWorkspace(home)
    const mine = store.addNode({
      ...terminal('my-card', 'Probe'),
      claudeSessionId: 'sess-413c8c39'
    } as TerminalNodeData) as TerminalNodeData

    const req: CliRequest = {
      ...request(['create', 'https://example.test', 'Report'], 'host-pane'),
      sessionId: 'sess-413c8c39'
    }
    await expect(cmdBrowser(req, deps)).resolves.toBe('delegated')

    // The whole point: 'my-card', never 'host-pane'. With the raw id the card
    // is created unconnected in the wrong caller's name.
    expect(browserCommand).toHaveBeenCalledWith(
      ['create', 'https://example.test', 'Report'],
      mine.id
    )
    expect(browserCommand).not.toHaveBeenCalledWith(expect.anything(), 'host-pane')
    expect(home).not.toBe(other)
  })

  // Tinker's review said the non-create site is "untested and untestable
  // through behaviour", because no engine reads the argument for those
  // subcommands. True of the ENGINES — and the reason I kept the change was
  // the next subcommand that does read it. But the delegation itself is a
  // contract, and a contract is observable at this seam even when the far side
  // ignores it. So it is testable after all, and now it is tested: revert that
  // site and this goes red while every behavioural test stays green.
  it('delegates the repaired id for NON-create subcommands too', async () => {
    const { store, deps, browserCommand } = setup()
    store.addNode(browser('b1', 'Docs'))
    store.addNode({
      ...terminal('my-card', 'Probe'),
      claudeSessionId: 'sess-413c8c39'
    } as TerminalNodeData)

    const req: CliRequest = {
      ...request(['info', 'Docs'], 'host-pane-elsewhere'),
      sessionId: 'sess-413c8c39'
    }
    await expect(cmdBrowser(req, deps)).resolves.toBe('delegated')
    expect(browserCommand).toHaveBeenCalledWith(['info', 'Docs'], 'my-card')
  })

  // Also from the review, and a consequence my commit message did not name:
  // --as is a real behaviour change on create. A plain shell used to pass an
  // empty id, so the card anchored at 0,0 and connected nothing; it now anchors
  // beside the named agent and owns an edge. That is what --as means everywhere
  // else, so it is intended — and intended behaviour with no test is how it
  // gets "fixed" back by someone reading only the diff.
  it('--as anchors the new card to the NAMED agent, not to nothing', async () => {
    const { store, deps, browserCommand } = setup()
    const named = store.addNode(terminal('agent-1', 'Probe')) as TerminalNodeData

    const req: CliRequest = {
      id: 'r1',
      cmd: 'browser',
      args: ['create', 'https://example.test', 'Report'],
      flags: { as: 'Probe' },
      terminalId: ''
    }
    await expect(cmdBrowser(req, deps)).resolves.toBe('delegated')
    expect(browserCommand).toHaveBeenCalledWith(
      ['create', 'https://example.test', 'Report'],
      named.id
    )
  })

  it('leaves an ordinary pane agent alone — no session, no repair', async () => {
    // The negative Probe named: seeing a repair for a NORMAL pane agent is
    // itself the regression, since those were all measured aligned.
    const { store, deps, browserCommand } = setup()
    const me = store.addNode(terminal('t1', 'Conductor')) as TerminalNodeData
    await expect(
      cmdBrowser(request(['create', 'https://example.test', 'X'], me.id), deps)
    ).resolves.toBe('delegated')
    expect(browserCommand).toHaveBeenCalledWith(
      ['create', 'https://example.test', 'X'],
      me.id
    )
  })
})
