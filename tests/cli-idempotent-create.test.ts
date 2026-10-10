import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cmdBrowser, cmdList } from '../src/main/socket-server'
import type { SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import type { BrowserNodeData, CliRequest, TerminalNodeData } from '../src/shared/model'

/**
 * A DELIVERABLE WITH THE SAME NAME IS THE SAME DELIVERABLE.
 *
 * Two agents opened the same page on the canvas twice: the UI engineer made
 * "UI · P1 Setup", the orchestrator could not see it — `cookrew list` lists
 * the cards WIRED TO THE CALLER, and `--all` lists agents only — so it made
 * "UI · P1 Setup" again and the store quietly minted "UI · P1 Setup (2)".
 * The owner ruled this is the product's to fix, not the agents' to be more
 * careful about. Two fixes, pinned here: `browser create` with a name that
 * already exists on this canvas wires the caller to that card (and navigates
 * it when the URL differs) instead of creating a second; and `cookrew list`
 * says how many cards on the canvas are not wired to you, with `--canvas`
 * listing every card and who it is wired to.
 */

function terminal(id: string, name: string): TerminalNodeData {
  return {
    kind: 'terminal', id, name, preset: 'Claude Code', command: 'claude', cwd: '/tmp',
    orch: false, role: null, position: { x: 10, y: 20 }, size: { width: 640, height: 420 }
  }
}

function browser(id: string, name: string, url: string): BrowserNodeData {
  return { kind: 'browser', id, name, url, position: { x: 700, y: 20 }, size: { width: 720, height: 560 } }
}

function request(cmd: string, args: string[], terminalId: string, flags: Record<string, unknown> = {}): CliRequest {
  return { id: 'r1', cmd, args, flags, terminalId } as CliRequest
}

function setup(): { store: WorkspaceStore; deps: SocketServerDeps; browserCommand: ReturnType<typeof vi.fn> } {
  const store = new WorkspaceStore(path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-idempotent-')), 'data'))
  store.addNode(terminal('atlas', 'Atlas'))
  store.addNode(terminal('velvet', 'Velvet'))
  store.addNode(browser('p1', 'UI · P1 Setup', 'file:///docs/ui/p1.html'))
  store.connect('velvet', 'p1')
  const browserCommand = vi.fn(() => Promise.resolve('delegated'))
  const deps = { store, browserCommand, listWorkspaces: () => store.list() } as unknown as SocketServerDeps
  return { store, deps, browserCommand }
}

describe('cookrew browser create — a name that exists is the same card', () => {
  it('wires the caller to the existing card instead of creating a second one', async () => {
    const { store, deps, browserCommand } = setup()
    const answer = await cmdBrowser(request('browser', ['create', 'file:///docs/ui/p1.html', 'UI · P1 Setup'], 'atlas'), deps)
    expect(browserCommand).not.toHaveBeenCalled()
    expect(answer).toContain('already exists')
    expect(answer).toContain('Velvet')
    expect(store.connectedTo('atlas').map((n) => n.id)).toContain('p1')
    expect(store.focusedState.nodes.filter((n) => n.kind === 'browser')).toHaveLength(1)
    expect(store.focusedState.nodes.some((n) => n.name.endsWith('(2)'))).toBe(false)
  })

  it('matches the name regardless of case, and navigates the card when the URL differs', async () => {
    const { deps, browserCommand } = setup()
    const answer = await cmdBrowser(request('browser', ['create', 'file:///docs/ui/p1-v2.html', 'ui · p1 setup'], 'atlas'), deps)
    expect(browserCommand).toHaveBeenCalledTimes(1)
    expect(browserCommand).toHaveBeenCalledWith(['navigate', 'UI · P1 Setup', 'file:///docs/ui/p1-v2.html'], 'atlas')
    expect(answer).toContain('navigated')
  })

  it('says so without re-wiring when the caller is already wired to it', async () => {
    const { store, deps } = setup()
    store.connect('atlas', 'p1')
    const before = store.focusedState.connections.length
    const answer = await cmdBrowser(request('browser', ['create', 'file:///docs/ui/p1.html', 'UI · P1 Setup'], 'atlas'), deps)
    expect(answer).toContain('already wired to you')
    expect(store.focusedState.connections).toHaveLength(before)
  })

  it('--new still creates a second card, through the engine, as before', async () => {
    const { deps, browserCommand } = setup()
    await cmdBrowser(request('browser', ['create', 'file:///docs/ui/p1.html', 'UI · P1 Setup'], 'atlas', { new: true }), deps)
    expect(browserCommand).toHaveBeenCalledWith(['create', 'file:///docs/ui/p1.html', 'UI · P1 Setup'], 'atlas')
  })

  it('a name nobody holds is created as before', async () => {
    const { deps, browserCommand } = setup()
    await cmdBrowser(request('browser', ['create', 'file:///docs/ui/p2.html', 'UI · P2 Catalogue'], 'atlas'), deps)
    expect(browserCommand).toHaveBeenCalledWith(['create', 'file:///docs/ui/p2.html', 'UI · P2 Catalogue'], 'atlas')
  })
})

describe('cookrew list — the cards you are not wired to are counted, and --canvas names them', () => {
  it('ends with how many cards on this canvas are not wired to the caller', () => {
    const { deps } = setup()
    const out = cmdList(request('list', [], 'atlas'), deps)
    expect(out).not.toContain('UI · P1 Setup')
    expect(out).toMatch(/2 more cards on this canvas are not wired to you/)
    expect(out).toContain('cookrew list --canvas')
  })

  it('--canvas lists every card with who it is wired to', () => {
    const { deps } = setup()
    const out = cmdList(request('list', [], 'atlas', { canvas: true }), deps)
    expect(out).toContain('"UI · P1 Setup"')
    expect(out).toMatch(/UI · P1 Setup.*wired to: Velvet/)
    expect(out).toContain('"Velvet"')
    expect(out).toContain('"Atlas"')
  })

  it('is silent about other cards when everything is wired to the caller', () => {
    const { store, deps } = setup()
    store.connect('atlas', 'p1')
    store.connect('atlas', 'velvet')
    const out = cmdList(request('list', [], 'atlas'), deps)
    expect(out).not.toMatch(/not wired to you/)
  })
})
