// `cookrew browser create --workspace` and `cookrew list --canvas --workspace`
// (owner, 2026-11-01): an agent makes cards in ITS OWN workspace and nowhere
// else, and a card it makes in a workspace nobody is looking at is stored
// there — not on whichever canvas the owner happens to have on screen.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cliWorkspaceScope, cmdBrowser, cmdList } from '../src/main/socket-server'
import type { SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import type { BrowserNodeData, CliRequest, TerminalNodeData } from '../src/shared/model'

const terminal = (id: string, name: string): TerminalNodeData => ({
  kind: 'terminal', id, name, preset: 'Claude Code', command: 'claude', cwd: '/tmp',
  orch: false, role: null, position: { x: 10, y: 20 }, size: { width: 640, height: 420 }
})
const request = (args: string[], terminalId: string, flags: Record<string, string | boolean> = {}): CliRequest => ({ id: 'r', cmd: 'browser', args, flags, terminalId })

function setup() {
  const store = new WorkspaceStore(path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-cli-ws-')), 'data'))
  const home = store.focusedId
  store.renameWorkspace(home, 'Home')
  const other = store.createWorkspace('Other', '/tmp').id
  const browserCommand = vi.fn(() => Promise.resolve('delegated'))
  const createBrowserInWorkspace = vi.fn((card: { url: string; name: string; terminalId: string; workspaceId: string }) => {
    const node = { kind: 'browser', id: `b-${card.name}`, name: card.name, url: card.url, position: { x: 0, y: 0 }, size: { width: 720, height: 560 } } as BrowserNodeData
    store.addNodeToWorkspace(card.workspaceId, node)
    store.connect(card.terminalId, node.id)
    return { name: card.name, adopted: false }
  })
  const deps = {
    store,
    browserCommand,
    createBrowserInWorkspace,
    listWorkspaces: () => store.list(),
    isServed: () => false
  } as unknown as SocketServerDeps
  return { store, deps, browserCommand, createBrowserInWorkspace, home, other }
}

describe('cliWorkspaceScope — whose workspace a call may touch', () => {
  const all = [{ id: 'w1', name: 'Home' }, { id: 'w2', name: 'Other' }]

  it('is the caller’s own workspace when nothing is named, never the one on screen', () => {
    expect(cliWorkspaceScope({ wanted: null, all, caller: { id: 'w1', name: 'Home' }, focused: 'w2' })).toEqual({ id: 'w1', name: 'Home' })
  })

  it('names its own workspace, by id or by name, case-blind', () => {
    expect(cliWorkspaceScope({ wanted: 'Home', all, caller: { id: 'w1', name: 'Home' }, focused: 'w1' }).id).toBe('w1')
    expect(cliWorkspaceScope({ wanted: 'w1', all, caller: { id: 'w1', name: 'Home' }, focused: 'w2' }).id).toBe('w1')
    expect(cliWorkspaceScope({ wanted: 'home', all, caller: null, focused: 'w2' }).id).toBe('w1')
  })

  it('refuses another workspace, and says nothing was created', () => {
    expect(() => cliWorkspaceScope({ wanted: 'Other', all, caller: { id: 'w1', name: 'Home' }, focused: 'w1' })).toThrow(/only make cards in your own workspace \("Home"\), not "Other"/)
    expect(() => cliWorkspaceScope({ wanted: 'Other', all, caller: { id: 'w1', name: 'Home' }, focused: 'w1' })).toThrow(/Nothing was created/)
  })

  it('refuses a name nobody has, listing the ones there are', () => {
    expect(() => cliWorkspaceScope({ wanted: 'Nope', all, caller: null, focused: 'w1' })).toThrow(/No workspace called 'Nope'.*Home, Other/)
  })

  it('lets a caller with no home workspace name any (a plain shell after a reboot)', () => {
    expect(cliWorkspaceScope({ wanted: 'Other', all, caller: null, focused: 'w1' }).id).toBe('w2')
    expect(cliWorkspaceScope({ wanted: null, all, caller: null, focused: 'w2' }).id).toBe('w2')
  })
})

describe('browser create — the caller’s workspace, not the focused one', () => {
  it('makes the card in the caller’s own workspace while another is on screen', async () => {
    const { store, deps, browserCommand, createBrowserInWorkspace, home, other } = setup()
    const me = store.addNode(terminal('t1', 'Conductor')) as TerminalNodeData
    store.switchWorkspace(other)
    const told = await cmdBrowser(request(['create', 'https://example.test/a', 'Chart'], me.id), deps)
    expect(createBrowserInWorkspace).toHaveBeenCalledWith({ url: 'https://example.test/a', name: 'Chart', terminalId: me.id, workspaceId: home })
    expect(browserCommand).not.toHaveBeenCalled()
    expect(told).toMatch(/workspace "Home"/)
    expect(store.workspaceState(home).nodes.some((n) => n.name === 'Chart')).toBe(true)
    expect(store.workspaceState(other).nodes.some((n) => n.name === 'Chart')).toBe(false)
  })

  it('takes --workspace when it names its own, and refuses another before anything is made', async () => {
    const { store, deps, createBrowserInWorkspace, home, other } = setup()
    const me = store.addNode(terminal('t1', 'Conductor')) as TerminalNodeData
    store.switchWorkspace(other)
    await cmdBrowser(request(['create', 'https://example.test/a', 'Chart'], me.id, { workspace: 'home' }), deps)
    expect(createBrowserInWorkspace).toHaveBeenCalledTimes(1)
    await expect(cmdBrowser(request(['create', 'https://example.test/b', 'Other'], me.id, { workspace: 'Other' }), deps)).rejects.toThrow(/own workspace/)
    expect(createBrowserInWorkspace).toHaveBeenCalledTimes(1)
    expect(store.workspaceState(home).nodes.map((n) => n.name)).not.toContain('Other')
  })

  it('still drives the on-screen engine when the caller’s workspace IS the one on screen', async () => {
    const { store, deps, browserCommand, createBrowserInWorkspace } = setup()
    const me = store.addNode(terminal('t1', 'Conductor')) as TerminalNodeData
    await cmdBrowser(request(['create', 'https://example.test/a', 'Chart'], me.id), deps)
    expect(browserCommand).toHaveBeenCalled()
    expect(createBrowserInWorkspace).not.toHaveBeenCalled()
  })
})

describe('list --workspace — the same scope rule as writing', () => {
  it('is the one spelling: list --workspace alone is mine, --canvas still answers', () => {
    const { store, deps, home } = setup()
    const me = store.addNode(terminal('t1', 'Conductor')) as TerminalNodeData
    store.addNodeToWorkspace(home, { kind: 'browser', id: 'b1', name: 'Mine', url: 'https://a.test', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } as BrowserNodeData)
    expect(cmdList(request([], me.id, { workspace: true }), deps)).toContain('"Mine"')
    expect(cmdList(request([], me.id, { workspace: 'Home' }), deps)).toContain('"Mine"')
    // The old flag is not a broken command for an agent that still types it.
    expect(cmdList(request([], me.id, { canvas: true }), deps)).toContain('"Mine"')
  })

  it('lists the caller’s own workspace, and a named one only when it is theirs', () => {
    const { store, deps, home, other } = setup()
    const me = store.addNode(terminal('t1', 'Conductor')) as TerminalNodeData
    store.addNodeToWorkspace(home, { kind: 'browser', id: 'b1', name: 'Mine', url: 'https://a.test', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } as BrowserNodeData)
    store.addNodeToWorkspace(other, { kind: 'browser', id: 'b2', name: 'Theirs', url: 'https://b.test', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } as BrowserNodeData)
    store.switchWorkspace(other)
    const mine = cmdList(request([], me.id, { workspace: true }), deps)
    expect(mine).toContain('"Mine"')
    expect(mine).not.toContain('"Theirs"')
    expect(() => cmdList(request([], me.id, { workspace: 'Other' }), deps)).toThrow(/own workspace/)
  })
})
