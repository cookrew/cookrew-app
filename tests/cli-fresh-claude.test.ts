// A fresh Claude on Solis (2026-11-09): what the CLI says and allows when a card
// cannot start (an untrusted home folder), when a caller wants to answer that,
// and when a caller wants to remove a card it recruited.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cmdAsk, cmdDismiss, cmdRecruit, cmdTrust } from '../src/main/socket-server'
import type { SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import type { CliRequest, TerminalNodeData } from '../src/shared/model'
import type { LaunchFailure } from '../src/shared/launch-failure'

const terminal = (id: string, name: string, orch = false): TerminalNodeData => ({
  kind: 'terminal', id, name, preset: 'Claude Code', command: 'claude --permission-mode bypassPermissions', cwd: '/home/ubuntu',
  orch, role: null, position: { x: 10, y: 20 }, size: { width: 640, height: 420 }
})
const request = (cmd: string, args: string[], terminalId: string | undefined, flags: Record<string, string | boolean> = {}): CliRequest =>
  ({ id: 'r', cmd, args, flags, ...(terminalId ? { terminalId } : {}) }) as CliRequest

const UNTRUSTED: LaunchFailure = {
  kind: 'folder-untrusted',
  why: 'Claude asks before it works in /home/ubuntu, your home folder, and Cookrew does not answer that for you.',
  fix: 'Trust it once (Trust this folder, or: cookrew trust "X"), or give this workspace a project folder. Then send again.',
  blocked: true,
  exitCode: null,
  lastLines: [],
  at: 1
}

function setup(options: { starts?: boolean; served?: string[]; busy?: string[] } = {}) {
  const store = new WorkspaceStore(path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-cli-fresh-')), 'data'))
  const failures = new Map<string, LaunchFailure>()
  const spawnTerminal = vi.fn((t: { id: string }) => {
    if (options.starts !== false) return true
    failures.set(t.id, UNTRUSTED)
    return false
  })
  const dispatch = {
    dispatch: vi.fn(async () => ({ status: 202, body: { dispatchId: 'd-1' } })),
    settled: vi.fn(async () => undefined),
    get: vi.fn(() => ({ state: 'delivered' }))
  }
  const dismissTerminal = vi.fn(async () => ({ ok: true }))
  const trustCardFolder = vi.fn((id: string) => {
    failures.delete(id)
    return { dir: '/home/ubuntu', outcome: 'trusted' as const, failure: null }
  })
  const deps = {
    store,
    agents: { list: () => [], lookup: (id: string) => (failures.has(id) ? { failure: failures.get(id) } : undefined) },
    ptys: { get: () => undefined },
    spawnTerminal,
    dismissTerminal,
    trustCardFolder,
    addWorkspaceDir: vi.fn(),
    listWorkspaces: () => store.list(),
    isServed: (id: string) => (options.served ?? []).includes(id),
    turns: {
      phaseOf: (id: string) => ((options.busy ?? []).includes(id) ? 'thinking' : 'idle'),
      backendPhaseFor: () => null
    },
    dispatch
  } as unknown as SocketServerDeps
  return { store, deps, spawnTerminal, dispatch, dismissTerminal, trustCardFolder }
}

describe('cookrew recruit, when the card cannot start', () => {
  it('says why at once and sends no brief into a card that never started', async () => {
    const { store, deps, dispatch } = setup({ starts: false })
    const me = store.addNode(terminal('t1', 'Roaster', true)) as TerminalNodeData
    await expect(cmdRecruit(request('recruit', ['X'], me.id, { prompt: 'say hi' }), deps)).rejects.toThrow(
      /Recruited "X".*cannot start: Claude asks before it works in \/home\/ubuntu.*cookrew trust/s
    )
    expect(dispatch.dispatch).not.toHaveBeenCalled()
    expect(store.workspaceState(store.focusedId).nodes.some((n) => n.name === 'X')).toBe(true)
  })

  it('records who recruited the card', async () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    await cmdRecruit(request('recruit', ['X'], me.id), deps)
    const made = store.workspaceState(store.focusedId).nodes.find((n) => n.name === 'X') as TerminalNodeData
    expect(made.recruitedBy).toBe(me.id)
  })
})

describe('cookrew ask, when the card cannot start', () => {
  it('names the reason and the way out instead of "no running terminal"', async () => {
    const { store, deps } = setup({ starts: false })
    const me = store.addNode(terminal('t1', 'Roaster', true)) as TerminalNodeData
    store.addNode(terminal('t2', 'X'))
    store.connect(me.id, 't2')
    await expect(cmdAsk(request('ask', ['X', 'say hi'], me.id), deps)).rejects.toThrow(
      /'X' cannot start: Claude asks before it works in \/home\/ubuntu.*cookrew trust/s
    )
  })
})

describe('cookrew dismiss', () => {
  it('lets a caller remove a card it recruited, though it is not the Orch', async () => {
    const { store, deps, dismissTerminal } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    await cmdRecruit(request('recruit', ['X'], me.id), deps)
    const made = store.workspaceState(store.focusedId).nodes.find((n) => n.name === 'X') as TerminalNodeData
    expect(await cmdDismiss(request('dismiss', ['X'], me.id), deps)).toBe('Dismissed "X"')
    expect(dismissTerminal).toHaveBeenCalledWith(made.id, 'agent')
  })

  it('still refuses a card the caller did not recruit, and says who may', async () => {
    const { store, deps, dismissTerminal } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    store.addNode(terminal('t2', 'X'))
    store.connect(me.id, 't2')
    await expect(cmdDismiss(request('dismiss', ['X'], me.id), deps)).rejects.toThrow(/Only the Orch, or the card that recruited "X"/)
    expect(dismissTerminal).not.toHaveBeenCalled()
  })
})

describe('cookrew trust', () => {
  it("trusts the named card's folder for Claude and says the card starts on the next send", async () => {
    const { store, deps, trustCardFolder } = setup()
    const me = store.addNode(terminal('t1', 'Roaster', true)) as TerminalNodeData
    store.addNode(terminal('t2', 'X'))
    store.connect(me.id, 't2')
    const told = await cmdTrust(request('trust', ['X'], me.id), deps)
    expect(trustCardFolder).toHaveBeenCalledWith('t2')
    expect(told).toMatch(/Claude trusts \/home\/ubuntu now/)
    expect(told).toMatch(/cookrew ask "X"/)
  })

  it('refuses a plain shell, naming the card button and a Shell card instead', async () => {
    const { store, deps, trustCardFolder } = setup()
    store.addNode(terminal('t2', 'X'))
    await expect(cmdTrust(request('trust', ['X'], undefined), deps)).rejects.toThrow(/person's answer.*Shell card.*Trust this folder/s)
    expect(trustCardFolder).not.toHaveBeenCalled()
  })

  it('refuses an agent mid-turn: the card that names the command must not answer it for the person', async () => {
    const { store, deps, trustCardFolder } = setup({ busy: ['t1'] })
    const me = store.addNode(terminal('t1', 'Roaster', true)) as TerminalNodeData
    store.addNode(terminal('t2', 'X'))
    store.connect(me.id, 't2')
    await expect(cmdTrust(request('trust', ['X'], me.id), deps)).rejects.toThrow(/mid-turn/)
    expect(trustCardFolder).not.toHaveBeenCalled()
  })

  it('refuses a caller it cannot place, rather than acting on the canvas on screen', async () => {
    const { store, deps, trustCardFolder } = setup()
    store.addNode(terminal('t2', 'X'))
    await expect(cmdTrust(request('trust', ['X'], 'ghost'), deps)).rejects.toThrow(/refused/)
    await expect(cmdTrust(request('trust', ['X'], undefined, { as: 'X' }), deps)).rejects.toThrow(/--as/)
    expect(trustCardFolder).not.toHaveBeenCalled()
  })

  it('needs a card name', async () => {
    const { deps } = setup()
    await expect(cmdTrust(request('trust', [], undefined), deps)).rejects.toThrow(/Usage: cookrew trust "Agent"/)
  })
})
