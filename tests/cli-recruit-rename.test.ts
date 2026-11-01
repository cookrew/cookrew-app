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
import { planRename } from '../src/main/agent-rename'
import type { CliRequest, TerminalNodeData } from '../src/shared/model'

const terminal = (id: string, name: string, orch = false): TerminalNodeData => ({
  kind: 'terminal', id, name, preset: 'Claude Code', command: 'claude', cwd: '/tmp/home-repo',
  orch, role: null, position: { x: 10, y: 20 }, size: { width: 640, height: 420 }
})
const request = (cmd: string, args: string[], terminalId: string, flags: Record<string, string | boolean> = {}): CliRequest => ({ id: 'r', cmd, args, flags, terminalId })

function setup(options: { sousName?: string | null; deliver?: 'ok' | 'refused' } = {}) {
  const store = new WorkspaceStore(path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-cli-recruit-')), 'data'))
  const home = store.focusedId
  store.renameWorkspace(home, 'Home')
  store.createWorkspace('Other', '/tmp/other-repo')
  const spawnTerminal = vi.fn()
  const addWorkspaceDir = vi.fn()
  const renameTerminal = vi.fn((id: string, wanted: string, onClash: 'refuse' | 'suffix') => {
    const hit = store.nodeAcrossWorkspaces(id)
    if (!hit) return { ok: false as const, error: 'gone' }
    const plan = planRename({ id, current: hit.node.name, wanted, siblings: store.workspaceState(hit.workspaceId).nodes, onClash })
    if (plan.ok && plan.changed) store.updateNode(id, { name: plan.name })
    return plan
  })
  const autoNameTerminal = vi.fn(async (id: string) =>
    options.sousName ? renameTerminal(id, options.sousName, 'suffix') : null
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
    renameTerminal,
    autoNameTerminal,
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

  it('renames an agent wired to the caller, and refuses one that is not', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    const mate = store.addNode(terminal('t2', 'Codex (3)')) as TerminalNodeData
    store.addNode(terminal('t3', 'Stranger'))
    store.connect(me.id, mate.id)
    cmdRename(request('rename', ['codex (3)', 'Reviewer'], me.id), deps)
    expect(store.node(mate.id)?.name).toBe('Reviewer')
    expect(() => cmdRename(request('rename', ['Stranger', 'Mine'], me.id), deps)).toThrow(/not you or an agent wired to you/)
  })

  it('lets the Orch rename any agent of its workspace', () => {
    const { store, deps } = setup()
    const orch = store.addNode(terminal('t1', 'Conductor', true)) as TerminalNodeData
    const other = store.addNode(terminal('t2', 'Claude Code (8)')) as TerminalNodeData
    cmdRename(request('rename', ['Claude Code (8)', 'Docs'], orch.id), deps)
    expect(store.node(other.id)?.name).toBe('Docs')
  })

  it('refuses a name another card wears, and an unchanged one is not an error', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    store.addNode(terminal('t2', 'Conductor'))
    expect(() => cmdRename(request('rename', ['Conductor'], me.id), deps)).toThrow(/already a card/)
    expect(store.node(me.id)?.name).toBe('Finch')
    expect(cmdRename(request('rename', ['Finch'], me.id), deps)).toMatch(/already called that/)
  })

  it('says how to use it', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    expect(() => cmdRename(request('rename', [], me.id), deps)).toThrow(/Usage: cookrew rename/)
    expect(() => cmdRename(request('rename', ['a', 'b', 'c'], me.id), deps)).toThrow(/Usage: cookrew rename/)
  })
})
