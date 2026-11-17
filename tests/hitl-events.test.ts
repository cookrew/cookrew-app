// WHAT AN AGENT DOES IS IN THE ACTIVITY LOG, AND SAYS IT WAS THE AGENT (owner,
// 2026-11-16; plan docs/hitl-cross-workspace-2026-11-15 · v6.2 phase 1). The
// HITL bar and the notifications read the event log, so every agent change to
// a note or a browser must land there as the agent's, and the owner's own
// changes as the owner's:
//  - a note an agent writes is `note.updated`, actor agent; one the owner
//    edits on its card is actor user; words that did not change are no event;
//  - a shell (`--as`) or a Shell card is the owner at a terminal, not an agent;
//  - an agent's browser create is ONE `browser.created`, the agent's; its
//    navigate and tab verbs are one `browser.navigated` each;
//  - "an agent waits on you" is one `agent.waiting` per wait, however often a
//    menu redraw flips the phase;
//  - a served workspace stays marked across a restart;
//  - the phone can ask the log for a few types since a moment.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CookrewEvent } from '../src/main/event-log'
import { HeadlessBrowserCommandEngine } from '../src/main/headless-browser-command'
import type { HeadlessBrowserManager } from '../src/main/headless-browser-manager'
import type { HeadlessInstance } from '../src/main/headless-chrome'
import { parseEventQuery } from '../src/main/mobile-api'
import { agentActorOf, cmdBrowser, cmdNote, type SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import { createWaitingLatch } from '../src/main/waiting-latch'
import type { BrowserNodeData, CliRequest, NoteNodeData, TerminalNodeData } from '../src/shared/model'

function terminal(id: string, name: string, command = 'claude', orch = false): TerminalNodeData {
  return {
    kind: 'terminal', id, name, preset: 'Claude Code', command, cwd: '/tmp',
    orch, role: null, position: { x: 10, y: 20 }, size: { width: 640, height: 420 }
  }
}

function note(id: string, content: string): NoteNodeData {
  return {
    kind: 'note', id, name: 'Plan', customName: 'Plan', content, locked: false,
    position: { x: 0, y: 0 }, size: { width: 300, height: 200 }
  }
}

function browser(id: string, name: string): BrowserNodeData {
  return {
    kind: 'browser', id, name, url: 'https://example.test/',
    tabs: [{ id: 'tab-1', url: 'https://example.test/', title: '' }], activeTabId: 'tab-1',
    position: { x: 0, y: 0 }, size: { width: 800, height: 600 }
  }
}

const req = (cmd: string, args: string[], terminalId: string, flags: Record<string, unknown> = {}): CliRequest =>
  ({ id: 'r1', cmd, args, flags, terminalId }) as CliRequest

function setup(over: Partial<SocketServerDeps> = {}) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-hitl-events-')), 'data')
  const store = new WorkspaceStore(dir)
  const events: CookrewEvent[] = []
  store.on('op', (e: CookrewEvent) => void events.push(e))
  const deps = {
    store,
    listWorkspaces: () => store.list(),
    agents: { list: () => [], lookup: () => undefined },
    isServed: () => false,
    ...over
  } as unknown as SocketServerDeps
  const of = (type: string) => events.filter((e) => e.type === type)
  return { dir, store, deps, events, of }
}

describe('who did it: an agent, or the owner at a terminal', () => {
  it('an agent card calling from its own pane is the agent; an orch card is the orch', () => {
    expect(agentActorOf(req('note', [], 'a'), terminal('a', 'Atlas'))).toBe('agent')
    expect(agentActorOf(req('note', [], 'o'), terminal('o', 'Lead', 'claude', true))).toBe('orch')
  })
  it('an agent known only by its session (no env id) is still the agent', () => {
    const request = { ...req('note', [], ''), sessionId: 'sess-1' } as CliRequest
    expect(agentActorOf(request, terminal('a', 'Atlas'))).toBe('agent')
  })
  it('a plain shell speaking --as an agent is the owner', () => {
    expect(agentActorOf(req('note', [], '', { as: 'Atlas' }), terminal('a', 'Atlas'))).toBeNull()
  })
  it('a Shell card (no command) is the owner', () => {
    expect(agentActorOf(req('note', [], 's'), terminal('s', 'Shell', '  '))).toBeNull()
  })
})

describe('notes in the log', () => {
  it("an agent's note create is the agent's", () => {
    const { store, deps, of } = setup()
    store.addNode(terminal('a', 'Atlas'))
    cmdNote(req('note', ['create', 'Findings\nfirst'], 'a'), deps)
    expect(of('note.created').map((e) => e.actor)).toEqual(['agent'])
  })

  it("an agent's write and edit are note.updated, the agent's", () => {
    const { store, deps, of } = setup()
    store.addNode(terminal('a', 'Atlas'))
    store.addNode(note('n', 'Plan\none'))
    store.connect('a', 'n')
    cmdNote(req('note', ['write', 'Plan', 'Plan\ntwo'], 'a'), deps)
    cmdNote(req('note', ['edit', 'Plan', 'two', 'three'], 'a'), deps)
    expect(of('note.updated').map((e) => [e.actor, e.entityId])).toEqual([['agent', 'n'], ['agent', 'n']])
  })

  it('words that did not change are no event', () => {
    const { store, deps, of } = setup()
    store.addNode(terminal('a', 'Atlas'))
    store.addNode(note('n', 'Plan\none'))
    store.connect('a', 'n')
    cmdNote(req('note', ['write', 'Plan', 'Plan\none'], 'a'), deps)
    expect(of('note.updated')).toEqual([])
  })

  it("a Shell card's write is the owner's", () => {
    const { store, deps, of } = setup()
    store.addNode(terminal('s', 'Shell', ''))
    store.addNode(note('n', 'Plan\none'))
    store.connect('s', 'n')
    cmdNote(req('note', ['write', 'Plan', 'Plan\ntwo'], 's'), deps)
    expect(of('note.updated').map((e) => e.actor)).toEqual(['user'])
  })

  it("the owner's edit on the card is note.updated, the owner's; moving it is no event", () => {
    const { store, of } = setup()
    store.addNode(note('n', 'Plan\none'))
    store.updateNode('n', { content: 'Plan\nmine' })
    store.updateNode('n', { position: { x: 5, y: 5 } })
    expect(of('note.updated').map((e) => e.actor)).toEqual(['user'])
  })

  it("a note in a workspace nobody is looking at is logged in ITS workspace", () => {
    const { store, of } = setup()
    const other = store.createWorkspace('Playground', '/tmp').id
    store.addNode(note('far', 'Far\none'), other)
    store.withOpContext({ actor: 'agent' }, () => store.writeNote('far', 'Far\ntwo'))
    expect(of('note.updated').map((e) => [e.workspaceId, e.actor])).toEqual([[other, 'agent']])
  })
})

describe('browsers in the log', () => {
  const scoped = (browserCommand: SocketServerDeps['browserCommand']) => ({ browserCommand, browserAnyWorkspace: () => true }) as Partial<SocketServerDeps>

  it("an agent's navigate is one browser.navigated, the agent's, for that card", async () => {
    const run = vi.fn(() => Promise.resolve('ok'))
    const { store, deps, of } = setup(scoped(run))
    store.addNode(terminal('a', 'Atlas'))
    store.addNode(browser('b', 'Docs'))
    await cmdBrowser(req('browser', ['navigate', 'Docs', 'https://example.test/2'], 'a'), deps)
    expect(of('browser.navigated').map((e) => [e.actor, e.entityId, e.details])).toEqual([['agent', 'b', 'navigate']])
  })

  it('each tab verb is one browser.navigated; reading the page is none', async () => {
    const run = vi.fn(() => Promise.resolve('ok'))
    const { store, deps, of } = setup(scoped(run))
    store.addNode(terminal('a', 'Atlas'))
    store.addNode(browser('b', 'Docs'))
    for (const verb of ['tab-new', 'tab-select', 'tab-close']) await cmdBrowser(req('browser', [verb, 'Docs', '1'], 'a'), deps)
    await cmdBrowser(req('browser', ['text', 'Docs'], 'a'), deps)
    expect(of('browser.navigated').map((e) => e.details)).toEqual(['tab-new', 'tab-select', 'tab-close'])
  })

  it('a verb that failed is no event', async () => {
    const run = vi.fn(() => Promise.reject(new Error('no page')))
    const { store, deps, of } = setup(scoped(run))
    store.addNode(terminal('a', 'Atlas'))
    store.addNode(browser('b', 'Docs'))
    await expect(cmdBrowser(req('browser', ['navigate', 'Docs', 'https://x.test'], 'a'), deps)).rejects.toThrow()
    expect(of('browser.navigated')).toEqual([])
  })

  it("the owner's shell (--as) driving a browser is no agent event", async () => {
    const run = vi.fn(() => Promise.resolve('ok'))
    const { store, deps, of } = setup(scoped(run))
    store.addNode(terminal('a', 'Atlas'))
    store.addNode(browser('b', 'Docs'))
    await cmdBrowser(req('browser', ['navigate', 'Docs', 'https://x.test'], '', { as: 'Atlas' }), deps)
    expect(of('browser.navigated')).toEqual([])
  })

  it('the legacy (focused) path logs the same', async () => {
    const run = vi.fn(() => Promise.resolve('ok'))
    const { store, deps, of } = setup({ browserCommand: run })
    store.addNode(terminal('a', 'Atlas'))
    store.addNode(browser('b', 'Docs'))
    await cmdBrowser(req('browser', ['navigate', 'Docs', 'https://x.test'], 'a'), deps)
    expect(of('browser.navigated').map((e) => e.actor)).toEqual(['agent'])
  })

  it('create hands the engine who is asking, and adopting a same-named card that moves is one browser.navigated', async () => {
    const run = vi.fn(() => Promise.resolve('ok'))
    const { store, deps, of } = setup(scoped(run))
    store.addNode(terminal('a', 'Atlas'))
    store.addNode(browser('b', 'Docs'))
    await cmdBrowser(req('browser', ['create', 'https://new.test', 'Fresh'], 'a'), deps)
    expect(run).toHaveBeenLastCalledWith(['create', 'https://new.test', 'Fresh'], 'a', 'agent')
    await cmdBrowser(req('browser', ['create', 'https://moved.test', 'Docs'], 'a'), deps)
    expect(of('browser.navigated').map((e) => [e.actor, e.entityId])).toEqual([['agent', 'b']])
  })

  it("the headless engine's create is ONE browser.created, the agent's", async () => {
    const { store, of } = setup()
    store.addNode(terminal('a', 'Atlas'))
    const instance = { navigate: vi.fn(() => Promise.resolve()) } as unknown as HeadlessInstance
    const manager = { syncNode: vi.fn(() => Promise.resolve(instance)) } as unknown as HeadlessBrowserManager
    const engine = new HeadlessBrowserCommandEngine({
      store,
      manager,
      addNode: (node, workspaceId, actor) =>
        actor ? store.withOpContext({ actor }, () => store.addNode(node, workspaceId)) : store.addNode(node, workspaceId),
      updateNode: (id, patch) => store.updateNode(id, patch),
      connectNodes: (x, y) => void store.connectAcross(x, y)
    })
    await engine.run(['create', 'https://new.test', 'Fresh'], 'a', 'agent')
    expect(of('browser.created').map((e) => e.actor)).toEqual(['agent'])
  })
})

describe('agent.waiting: once per wait', () => {
  it('a tracked wait is said once, however often it is pushed', () => {
    const latch = createWaitingLatch()
    expect([1, 1, 1].map((seq) => latch.observe('a', 'waiting', seq))).toEqual([true, false, false])
  })
  it('a second approval in the same turn is a new wait, said again', () => {
    const latch = createWaitingLatch()
    expect(latch.observe('a', 'waiting', 1)).toBe(true)
    expect(latch.observe('a', 'thinking', 1)).toBe(false)
    expect(latch.observe('a', 'waiting', 2)).toBe(true)
  })
  it('a card with no count (herdr only) is said once until it replies or rests, however it flips', () => {
    const latch = createWaitingLatch()
    const said = ['waiting', 'thinking', 'waiting', 'thinking', 'waiting'].map((p) => latch.observe('a', p as never))
    expect(said).toEqual([true, false, false, false, false])
  })
  it('a reply or a rest ends the wait; the next wait is said again', () => {
    const latch = createWaitingLatch()
    latch.observe('a', 'waiting')
    latch.observe('a', 'replied')
    expect(latch.observe('a', 'waiting')).toBe(true)
    latch.observe('a', 'idle')
    expect(latch.observe('a', 'waiting')).toBe(true)
  })
  it('a finished turn ends the wait too', () => {
    const latch = createWaitingLatch()
    latch.observe('a', 'waiting')
    latch.clear('a')
    expect(latch.observe('a', 'waiting')).toBe(true)
  })
  it('agents are latched apart', () => {
    const latch = createWaitingLatch()
    expect(latch.observe('a', 'waiting')).toBe(true)
    expect(latch.observe('b', 'waiting')).toBe(true)
  })
})

describe('a served workspace stays marked', () => {
  it('the mark is in the list, is announced, and survives a restart', () => {
    const { dir, store } = setup()
    const ws = store.createWorkspace('Door', '/tmp').id
    const lists: unknown[] = []
    store.on('workspaces', (list: unknown) => void lists.push(list))
    store.markServed(ws)
    expect(store.list().workspaces.find((w) => w.id === ws)?.served).toBe(true)
    expect(lists).toHaveLength(1)
    const again = new WorkspaceStore(dir)
    expect(again.list().workspaces.find((w) => w.id === ws)?.served).toBe(true)
  })
  it('marking twice is one announcement', () => {
    const { store } = setup()
    const ws = store.createWorkspace('Door', '/tmp').id
    const lists: unknown[] = []
    store.on('workspaces', (list: unknown) => void lists.push(list))
    store.markServed(ws)
    store.markServed(ws)
    expect(lists).toHaveLength(1)
  })
})

describe("the phone's event query", () => {
  it('reads a comma list of types, with since and limit', () => {
    const q = parseEventQuery(new URLSearchParams('types=agent.waiting,turn.completed&since=100&limit=50'))
    expect(q).toMatchObject({ types: ['agent.waiting', 'turn.completed'], since: 100, limit: 50 })
  })
  it('reads a per-type limit, and drops one that is not a positive count', () => {
    expect(parseEventQuery(new URLSearchParams('types=a,b&limitPerType=200')).limitPerType).toBe(200)
    for (const bad of ['0', '-3', 'x', '']) expect(parseEventQuery(new URLSearchParams(`limitPerType=${bad}`)).limitPerType).toBeUndefined()
  })
  it('drops empty and oversized entries, and caps how many', () => {
    const many = Array.from({ length: 80 }, (_, i) => `t${i}`).join(',')
    expect(parseEventQuery(new URLSearchParams(`types=${many}`)).types).toHaveLength(32)
    expect(parseEventQuery(new URLSearchParams(`types=a,,${'x'.repeat(100)}`)).types).toEqual(['a'])
    expect(parseEventQuery(new URLSearchParams('')).types).toBeUndefined()
  })
})
