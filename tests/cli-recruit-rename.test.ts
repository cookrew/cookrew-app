// `cookrew recruit --prompt` and `cookrew rename` (owner, 2026-11-01): an
// agent driven by another model makes a teammate from a prompt and gets a
// real name for it, not the prompt cut short; and any agent renames itself
// the way /rename names the chat it is typed in.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cmdRecruit, cmdRename } from '../src/main/socket-server'
import type { SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import { renameCardIn } from '../src/main/agent-rename'
import type { CanvasNode, CliRequest, TerminalNodeData } from '../src/shared/model'

const terminal = (id: string, name: string, orch = false): TerminalNodeData => ({
  kind: 'terminal', id, name, preset: 'Claude Code', command: 'claude', cwd: '/tmp/home-repo',
  orch, role: null, position: { x: 10, y: 20 }, size: { width: 640, height: 420 }
})
const request = (cmd: string, args: string[], terminalId: string, flags: Record<string, string | boolean> = {}): CliRequest => ({ id: 'r', cmd, args, flags, terminalId })

function setup(options: { sousName?: string | null; deliver?: 'ok' | 'refused'; served?: string[] } = {}) {
  const store = new WorkspaceStore(path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-cli-recruit-')), 'data'))
  const home = store.focusedId
  store.renameWorkspace(home, 'Home')
  store.createWorkspace('Other', '/tmp/other-repo')
  const spawnTerminal = vi.fn()
  const addWorkspaceDir = vi.fn()
  // The app's own rename path (agent-rename.ts), on this store.
  const renameCard = vi.fn((id: string, wanted: string, onClash: 'refuse' | 'suffix', by?: string) =>
    renameCardIn(
      {
        find: (nodeId) => store.nodeAcrossWorkspaces(nodeId),
        siblings: (workspaceId) => store.workspaceState(workspaceId).nodes,
        update: (nodeId, patch) => store.updateNode(nodeId, patch),
        pin: (nodeId) => store.updateNodeUnsafe(nodeId, { nameByHand: true })
      },
      id,
      wanted,
      onClash,
      onClash === 'refuse',
      by
    )
  )
  const autoNameTerminal = vi.fn(async (id: string) =>
    options.sousName ? renameCard(id, options.sousName, 'suffix') : null
  )
  const dispatched: { agentId: string; text: string; origin?: string }[] = []
  const dispatch = {
    dispatch: vi.fn(async (agentId: string, input: { text: string; origin?: string }) => {
      dispatched.push({ agentId, ...input })
      return options.deliver === 'refused'
        ? { status: 409, body: { error: 'agent busy' } }
        : { status: 202, body: { dispatchId: 'd-1' } }
    }),
    settled: vi.fn(async () => undefined),
    get: vi.fn(() => ({ state: 'delivered' }))
  }
  const deps = {
    store,
    agents: { list: () => [], lookup: () => undefined },
    spawnTerminal,
    addWorkspaceDir,
    listWorkspaces: () => store.list(),
    renameCard,
    autoNameTerminal,
    isServed: (id: string) => (options.served ?? []).includes(id),
    dispatch
  } as unknown as SocketServerDeps
  return { store, deps, home, spawnTerminal, addWorkspaceDir, autoNameTerminal, dispatched }
}

const recruits = (store: WorkspaceStore, home: string, callerId: string): TerminalNodeData[] =>
  store.workspaceState(home).nodes.filter((n): n is TerminalNodeData => n.kind === 'terminal' && n.id !== callerId)

describe('cookrew recruit --prompt', () => {
  it('lets an agent that is not the Orch recruit beside it, named by Sous from the prompt', async () => {
    const { store, deps, home, spawnTerminal, dispatched } = setup({ sousName: '顶栏模型切换' })
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    const prompt = '把模型切换放到顶栏右边，并且在手机上也能用'
    const told = await cmdRecruit(request('recruit', [], me.id, { prompt }), deps)

    const [made] = recruits(store, home, me.id)
    expect(made.name).toBe('顶栏模型切换')
    expect(made.brief).toBe(prompt)
    expect(made.orch).toBe(false)
    expect(spawnTerminal).toHaveBeenCalledTimes(1)
    expect(store.connectedTo(me.id).map((n) => n.id)).toContain(made.id)
    expect(dispatched).toEqual([{ agentId: made.id, text: prompt, origin: me.id }])
    expect(told).toMatch(/Recruited "顶栏模型切换"/)
    expect(told).toMatch(/stand-in was "把模型切换放"/)
    expect(told).toMatch(/Prompt delivered \(dispatch d-1\)/)
  })

  it('keeps the stand-in when Sous has nothing better', async () => {
    const { store, deps, home } = setup({ sousName: null })
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    const told = await cmdRecruit(request('recruit', [], me.id, { prompt: 'fix the login redirect bug' }), deps)
    expect(recruits(store, home, me.id)[0].name).toBe('Login Redirect')
    expect(told).toMatch(/Recruited "Login Redirect"/)
    expect(told).not.toMatch(/stand-in/)
  })

  it('wears a chosen name as given, and does not ask Sous', async () => {
    const { store, deps, home, autoNameTerminal } = setup({ sousName: 'Ignored' })
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    await cmdRecruit(request('recruit', ['  Billing   Webhook '], me.id, { prompt: 'fix the 500 on the webhook' }), deps)
    expect(recruits(store, home, me.id)[0].name).toBe('Billing Webhook')
    expect(autoNameTerminal).not.toHaveBeenCalled()
  })

  it('refuses a chosen name another card wears, and creates nothing', async () => {
    const { store, deps, home, spawnTerminal } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    store.addNode(terminal('t2', 'Conductor'))
    await expect(cmdRecruit(request('recruit', ['conductor'], me.id), deps)).rejects.toThrow(/already a card in this workspace.*Nothing was created/)
    expect(recruits(store, home, me.id).map((n) => n.name)).toEqual(['Conductor'])
    expect(spawnTerminal).not.toHaveBeenCalled()
  })

  it('without a prompt it still works as before: the name, or the preset’s', async () => {
    const { store, deps, home, autoNameTerminal, dispatched } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    await cmdRecruit(request('recruit', [], me.id, { preset: 'codex' }), deps)
    expect(recruits(store, home, me.id)[0].name).toBe('Codex')
    expect(autoNameTerminal).not.toHaveBeenCalled()
    expect(dispatched).toEqual([])
  })

  it('only the Orch recruits into another directory', async () => {
    const { store, deps, home, addWorkspaceDir } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    await expect(cmdRecruit(request('recruit', ['Scout'], me.id, { dir: '/tmp/elsewhere' }), deps)).rejects.toThrow(/Only the Orch.*Nothing was created/)
    expect(recruits(store, home, me.id)).toEqual([])

    const orch = store.addNode(terminal('t9', 'Conductor', true)) as TerminalNodeData
    await cmdRecruit(request('recruit', ['Scout'], orch.id, { dir: '/tmp/elsewhere' }), deps)
    expect(addWorkspaceDir).toHaveBeenCalledWith(home, '/tmp/elsewhere')
  })

  it('fails loudly when the prompt did not reach the card, naming the card that exists', async () => {
    const { store, deps, home } = setup({ deliver: 'refused' })
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    await expect(cmdRecruit(request('recruit', ['Scout'], me.id, { prompt: 'look around' }), deps)).rejects.toThrow(
      /Recruited "Scout"[\s\S]*did not reach "Scout"[\s\S]*cookrew ask "Scout"/
    )
    expect(recruits(store, home, me.id).map((n) => n.name)).toEqual(['Scout'])
  })

  // 2026-11-03, six of six: "Prompt delivered" over an empty composer. With
  // the card's view wired, the brief waits for the harness and "delivered"
  // needs evidence; without it the card stays, the dispatch is closed and the
  // command fails with the plain sentence.
  it('says "Card created, brief NOT confirmed" and fails when the brief never shows up on the card', async () => {
    const { store, deps, home } = setup()
    const interrupt = vi.fn()
    const witness = { readyForInput: () => true, turnRunning: () => false, turnCount: () => 0, screen: () => '' }
    const watched = { ...deps, dispatch: { ...deps.dispatch!, get: () => ({ state: 'running' }), interrupt }, recruitWitness: witness, recruitTiming: { confirmMs: 0, retryMs: 1 } } as unknown as SocketServerDeps
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    await expect(cmdRecruit(request('recruit', ['Scout'], me.id, { prompt: 'look around' }), watched)).rejects.toThrow(
      /Recruited "Scout"[\s\S]*Card created, brief NOT confirmed[\s\S]*no turn started[\s\S]*cookrew check "Scout"/
    )
    expect(interrupt).toHaveBeenCalledWith('d-1', expect.stringMatching(/not confirmed/))
    expect(recruits(store, home, me.id).map((n) => n.name)).toEqual(['Scout'])
  })

  it('says which evidence confirmed the brief', async () => {
    const { store, deps } = setup()
    const sentence = 'look around the repo and list the open TODOs'
    const witness = { readyForInput: () => true, turnRunning: () => false, turnCount: () => 0, screen: () => `❯ ${sentence}` }
    const watched = { ...deps, dispatch: { ...deps.dispatch!, get: () => ({ state: 'running' }) }, recruitWitness: witness, recruitTiming: { retryMs: 1 } } as unknown as SocketServerDeps
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    const told = await cmdRecruit(request('recruit', ['Scout'], me.id, { prompt: sentence }), watched)
    expect(told).toMatch(/Prompt delivered \(dispatch d-1, seen on its screen\)/)
  })

  it('refuses a prompt for a bare shell, and an empty --prompt', async () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    await expect(cmdRecruit(request('recruit', [], me.id, { preset: 'Shell', prompt: 'ls' }), deps)).rejects.toThrow(/bare shell/)
    await expect(cmdRecruit(request('recruit', [], me.id, { prompt: true }), deps)).rejects.toThrow(/--prompt needs the task/)
  })
})

describe('cookrew rename', () => {
  it('one argument renames the caller', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', '把模型切换放')) as TerminalNodeData
    expect(cmdRename(request('rename', ['Agent Naming'], me.id), deps)).toBe('Renamed "把模型切换放" → "Agent Naming"')
    expect(store.node(me.id)?.name).toBe('Agent Naming')
  })

  it('renames any agent of the caller\'s workspace, wired or not, and lays no cable', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    const mate = store.addNode(terminal('t2', 'Codex (3)')) as TerminalNodeData
    const stranger = store.addNode(terminal('t3', 'Stranger')) as TerminalNodeData
    store.connect(me.id, mate.id)
    cmdRename(request('rename', ['codex (3)', 'Reviewer'], me.id), deps)
    expect(store.node(mate.id)?.name).toBe('Reviewer')
    expect(cmdRename(request('rename', ['Stranger', 'Docs'], me.id), deps)).toBe('Renamed "Stranger" → "Docs"')
    expect(store.node(stranger.id)?.name).toBe('Docs')
    expect(store.isConnected(me.id, stranger.id)).toBe(false)
  })

  it('renames a note and pins the name, so its next edit does not rename it back', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    const note = store.createNote({
      customName: null, content: '# Scratch\nbody', locked: false,
      position: { x: 0, y: 0 }, size: { width: 300, height: 200 }
    })
    cmdRename(request('rename', [note.name, 'Release Plan'], me.id), deps)
    expect(store.node(note.id)?.name).toBe('Release Plan')
    store.writeNote(note.id, '# Something else\nnew body')
    expect(store.node(note.id)?.name).toBe('Release Plan')
  })

  it('renames a browser card', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    const page = store.addNode({
      kind: 'browser', id: 'b1', name: 'Browser', url: 'https://example.com',
      position: { x: 0, y: 0 }, size: { width: 400, height: 300 }
    } as unknown as CanvasNode)
    cmdRename(request('rename', ['browser', 'Staging'], me.id), deps)
    expect(store.node(page.id)?.name).toBe('Staging')
  })

  it('refuses a name two kinds of card share, until --kind picks one', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    const agent = store.addNode(terminal('t2', 'Docs')) as TerminalNodeData
    // addNode keeps names unique; an older canvas (or a direct patch) may not.
    const note = store.addNode({
      kind: 'note', id: 'n1', name: 'Notes', customName: 'Notes', content: '', locked: false,
      position: { x: 0, y: 0 }, size: { width: 300, height: 200 }
    } as unknown as CanvasNode)
    store.updateNode(note.id, { name: 'Docs', customName: 'Docs' })
    expect(() => cmdRename(request('rename', ['Docs', 'Writer'], me.id), deps)).toThrow(/2 cards are called 'Docs'.*--kind agent\|note/)
    cmdRename(request('rename', ['Docs', 'Writer'], me.id, { kind: 'note' }), deps)
    expect(store.node(note.id)?.name).toBe('Writer')
    expect(store.node(agent.id)?.name).toBe('Docs')
    expect(() => cmdRename(request('rename', ['Docs', 'X'], me.id, { kind: 'pane' }), deps)).toThrow(/--kind is one of/)
  })

  it('two wired agents of one name in two workspaces resolve as ask does: the first wins', () => {
    const { store, deps, home } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    const other = store.list().workspaces.find((w) => w.id !== home)!.id
    const here = store.addNode(terminal('t2', 'Reviewer')) as TerminalNodeData
    const there = store.addNode(terminal('t3', 'Reviewer'), other) as TerminalNodeData
    store.connectAcross(me.id, here.id)
    store.connectAcross(me.id, there.id)
    expect(() => cmdRename(request('rename', ['Reviewer', 'Critic'], me.id), deps)).not.toThrow()
    expect([store.nodeAcrossWorkspaces(here.id)?.node.name, store.nodeAcrossWorkspaces(there.id)?.node.name]).toContain('Critic')
  })

  it('never reaches another workspace\'s card unwired, and holds a served caller to its wires', () => {
    const { store, deps } = setup({ served: ['t1'] })
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    store.addNode(terminal('t2', 'Neighbour'))
    expect(() => cmdRename(request('rename', ['Neighbour', 'Mine'], me.id), deps)).toThrow(/not you or a card wired to you/)

    const open = setup()
    const caller = open.store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    const other = open.store.list().workspaces.find((w) => w.id !== open.home)!.id
    open.store.addNode(terminal('t9', 'Faraway'), other)
    expect(() => cmdRename(request('rename', ['Faraway', 'Mine'], caller.id), open.deps)).toThrow(/not you or a card in your workspace or wired to you/)
  })

  it('only the Orch itself renames the Orch; and the renamer is named', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    const orch = store.addNode(terminal('t2', 'Conductor', true)) as TerminalNodeData
    expect(() => cmdRename(request('rename', ['Conductor', 'Finch Jr'], me.id), deps)).toThrow(/is the Orch\. Only it/)
    expect(store.node(orch.id)?.name).toBe('Conductor')
    cmdRename(request('rename', ['Door'], orch.id), deps)
    expect(store.node(orch.id)?.name).toBe('Door')
    const renameCard = (deps as unknown as { renameCard: { mock: { calls: unknown[][] } } }).renameCard
    expect(renameCard.mock.calls.at(-1)?.[3]).toBe('"Conductor" (orch, cookrew rename)')
  })

  it('refuses a name another card wears, and an unchanged one is not an error', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    store.addNode(terminal('t2', 'Conductor'))
    expect(() => cmdRename(request('rename', ['Conductor'], me.id), deps)).toThrow(/already a card/)
    expect(store.node(me.id)?.name).toBe('Finch')
    expect(cmdRename(request('rename', ['Finch'], me.id), deps)).toMatch(/already called that/)
  })

  it('renames the caller when its canvas is not the one on screen', () => {
    const { store, deps, home } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    const other = store.list().workspaces.find((w) => w.id !== home)!.id
    store.switchWorkspace(other)
    expect(store.focusedId).not.toBe(home)
    expect(cmdRename(request('rename', ['Robin'], me.id), deps)).toBe('Renamed "Finch" → "Robin"')
    expect(store.nodeAcrossWorkspaces(me.id)?.node.name).toBe('Robin')
  })

  it('says how to use it', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    expect(() => cmdRename(request('rename', [], me.id), deps)).toThrow(/Usage: cookrew rename/)
    expect(() => cmdRename(request('rename', ['a', 'b', 'c'], me.id), deps)).toThrow(/Usage: cookrew rename/)
  })
})
