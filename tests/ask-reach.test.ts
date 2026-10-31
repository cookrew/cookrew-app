// ANY TEAMMATE IN THE SAME WORKSPACE IS ASKABLE, AND ASKING WIRES THE TWO.
//
// Owner, 2026-10-31: a Cookrew teammate may ask any agent, read or write any
// note and drive any browser of its own workspace, and the inquiry itself
// creates the cable between them. Before this, ask/check/note answered "not
// found among your connections" for 112 of the 302 cards on Cookrew Dev, and
// the only way through was an orch running `cookrew connect` first.
//
// The rules these pin:
//  - a wired card is still found first, wherever it lives (mirrored edges);
//  - an unwired card on the CALLER'S canvas is found by name and wired;
//  - a card on another workspace's canvas is never reached unwired;
//  - a served caller keeps the old rule (wired only) — its canvas is a
//    sandbox the owner prepared, not a room it may rewire;
//  - `note delete` still needs a wire: removing is not asking.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { reachByName } from '../src/main/ask-reach'
import { cmdBrowser, cmdList, cmdNote, reachCard } from '../src/main/socket-server'
import type { SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import type { BrowserNodeData, CliRequest, NoteNodeData, TerminalNodeData } from '../src/shared/model'

function terminal(id: string, name: string): TerminalNodeData {
  return {
    kind: 'terminal', id, name, preset: 'Claude Code', command: 'claude', cwd: '/tmp',
    orch: false, role: null, position: { x: 10, y: 20 }, size: { width: 640, height: 420 }
  }
}

function note(id: string, content: string): NoteNodeData {
  return {
    kind: 'note', id, name: 'Plan', customName: null, content, locked: false,
    position: { x: 0, y: 0 }, size: { width: 300, height: 200 }
  }
}

function browser(id: string, name: string): BrowserNodeData {
  return {
    kind: 'browser', id, name, url: 'https://example.com/',
    position: { x: 0, y: 0 }, size: { width: 800, height: 600 }
  } as BrowserNodeData
}

function request(cmd: string, args: string[], terminalId: string): CliRequest {
  return { id: 'r1', cmd, args, flags: {}, terminalId }
}

function setup(over: Partial<SocketServerDeps> = {}) {
  const store = new WorkspaceStore(
    path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-ask-reach-')), 'data')
  )
  const home = store.focusedId
  store.renameWorkspace(home, 'Cookrew Dev')
  const other = store.createWorkspace('Playground', '/tmp').id
  const deps = {
    store,
    listWorkspaces: () => store.list(),
    agents: { list: () => [], lookup: () => undefined },
    isServed: () => false,
    ...over
  } as unknown as SocketServerDeps
  return { store, deps, home, other }
}

describe('reachByName — who a name can reach', () => {
  const me = terminal('me', 'Conductor')
  const forge = terminal('forge', 'Forge')
  const farForge = terminal('far-forge', 'Forge')

  it('finds an unwired card on the caller’s own canvas and says to wire it', () => {
    const hit = reachByName({
      selfId: me.id, name: 'forge', kind: 'terminal', wired: [],
      canvas: { workspaceId: 'ws', nodes: [me, forge] }
    })
    expect(hit).toEqual({ node: forge, workspaceId: 'ws', wire: true })
  })

  it('prefers a card already wired, even one in another workspace', () => {
    const hit = reachByName({
      selfId: me.id, name: 'Forge', kind: 'terminal',
      wired: [{ node: farForge, workspaceId: 'far' }],
      canvas: { workspaceId: 'ws', nodes: [me, forge] }
    })
    expect(hit).toEqual({ node: farForge, workspaceId: 'far', wire: false })
  })

  it('never resolves to the caller itself', () => {
    const hit = reachByName({
      selfId: me.id, name: 'Conductor', kind: 'terminal', wired: [],
      canvas: { workspaceId: 'ws', nodes: [me] }
    })
    expect(hit).toBeNull()
  })

  it('matches the kind asked for', () => {
    const hit = reachByName({
      selfId: me.id, name: 'Forge', kind: 'note', wired: [],
      canvas: { workspaceId: 'ws', nodes: [me, forge] }
    })
    expect(hit).toBeNull()
  })

  it('without a canvas (a served caller) reaches only what is wired', () => {
    const hit = reachByName({ selfId: me.id, name: 'Forge', kind: 'terminal', wired: [], canvas: null })
    expect(hit).toBeNull()
  })
})

describe('asking wires the asker to what it asked', () => {
  it('reads an unwired note on its own canvas and leaves a cable behind', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Velvet')) as TerminalNodeData
    const plan = store.addNode(note('n1', '# Plan\nship it')) as NoteNodeData
    expect(store.isConnected(me.id, plan.id)).toBe(false)
    const out = cmdNote(request('note', ['read', plan.name], me.id), deps)
    expect(out).toContain('ship it')
    expect(store.isConnected(me.id, plan.id)).toBe(true)
  })

  it('wires once: a second read adds no second cable', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Velvet')) as TerminalNodeData
    const plan = store.addNode(note('n1', '# Plan')) as NoteNodeData
    cmdNote(request('note', ['read', plan.name], me.id), deps)
    cmdNote(request('note', ['read', plan.name], me.id), deps)
    const cables = store.workspaceState(store.focusedId).connections
    expect(cables).toHaveLength(1)
  })

  it('writes an unwired note and wires it', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Velvet')) as TerminalNodeData
    const plan = store.addNode(note('n1', '# Plan')) as NoteNodeData
    cmdNote(request('note', ['write', plan.name, '# Plan\nv2'], me.id), deps)
    expect((store.node(plan.id) as NoteNodeData).content).toContain('v2')
    expect(store.isConnected(me.id, plan.id)).toBe(true)
  })

  it('wires inside the caller’s workspace while the owner looks at another one', () => {
    const { store, deps, home, other } = setup()
    const me = store.addNode(terminal('t1', 'Velvet')) as TerminalNodeData
    const forge = store.addNode(terminal('t2', 'Forge')) as TerminalNodeData
    store.switchWorkspace(other)
    const target = reachCard(request('ask', ['Forge', 'hi'], me.id), deps, 'Forge', 'terminal', 'ask')
    expect(target.id).toBe(forge.id)
    const cables = store.workspaceState(home).connections
    expect(cables.some((c) => [c.a, c.b].sort().join() === [me.id, forge.id].sort().join())).toBe(true)
    expect(store.workspaceState(other).connections).toHaveLength(0)
  })

  it('does not reach a card on another workspace’s canvas', () => {
    const { store, deps, other } = setup()
    const me = store.addNode(terminal('t1', 'Velvet')) as TerminalNodeData
    store.addNodeToWorkspace(other, terminal('t9', 'Stranger'))
    expect(() => reachCard(request('ask', ['Stranger', 'hi'], me.id), deps, 'Stranger', 'terminal', 'ask'))
      .toThrow(/not found in your workspace/)
  })

  it('refuses to ask yourself', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Velvet')) as TerminalNodeData
    expect(() => reachCard(request('ask', ['Velvet', 'hi'], me.id), deps, 'Velvet', 'terminal', 'ask'))
      .toThrow(/that is you/i)
  })

  it('keeps a served caller to its wires', () => {
    const { store, deps } = setup({ isServed: () => true })
    const me = store.addNode(terminal('t1', 'Guest')) as TerminalNodeData
    const plan = store.addNode(note('n1', '# Owner plan')) as NoteNodeData
    expect(() => cmdNote(request('note', ['read', plan.name], me.id), deps)).toThrow(/not found/)
    expect(store.isConnected(me.id, plan.id)).toBe(false)
  })

  it('still needs a wire to delete a note', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Velvet')) as TerminalNodeData
    const plan = store.addNode(note('n1', '# Plan')) as NoteNodeData
    expect(() => cmdNote(request('note', ['delete', plan.name], me.id), deps)).toThrow(/not wired to you/)
    expect(store.node(plan.id)).toBeDefined()
  })

  it('drives an unwired browser on its canvas and wires it before the pulse', async () => {
    const pulses: Array<{ from: string; to: string; wired: boolean }> = []
    const { store, deps } = setup({
      browserCommand: async () => 'ok',
      signal: (m) => pulses.push({ from: m.from, to: m.to, wired: store.isConnected(m.from, m.to) })
    })
    const me = store.addNode(terminal('t1', 'Velvet')) as TerminalNodeData
    const page = store.addNode(browser('b1', 'Docs')) as BrowserNodeData
    await cmdBrowser(request('browser', ['snapshot', 'Docs'], me.id), deps)
    expect(store.isConnected(me.id, page.id)).toBe(true)
    expect(pulses).toEqual([{ from: page.id, to: me.id, wired: true }])
  })

  it('does not wire a browser when the verb is not traffic on it', async () => {
    const { store, deps } = setup({ browserCommand: async () => 'closed' })
    const me = store.addNode(terminal('t1', 'Velvet')) as TerminalNodeData
    const page = store.addNode(browser('b1', 'Docs')) as BrowserNodeData
    await cmdBrowser(request('browser', ['close', 'Docs'], me.id), deps)
    expect(store.isConnected(me.id, page.id)).toBe(false)
  })

  it('`cookrew list` says the unwired cards are askable by name', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Velvet')) as TerminalNodeData
    store.addNode(terminal('t2', 'Forge'))
    const out = cmdList(request('list', [], me.id), deps)
    expect(out).toMatch(/ask, read or drive any of them by name/)
  })
})
