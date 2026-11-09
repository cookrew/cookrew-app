// `cookrew browser …` on the headless engine, with ANOTHER workspace on screen.
//
// Owner ruling 2026-11-04: every workspace works on its own; switching what
// the window shows must never stop or refuse anything elsewhere. Live failure
// that day: the GOAT Team orch's D1-Shots was driving "Solis-Shots" when the
// owner switched to Cookrew Dev, and the next command answered "Browsers are
// driven in the active workspace only". Three tries, three dead tasks.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cmdBrowser } from '../src/main/socket-server'
import type { SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import type { BrowserNodeData, CliRequest, TerminalNodeData } from '../src/shared/model'

const terminal = (id: string, name: string): TerminalNodeData => ({
  kind: 'terminal', id, name, preset: 'Claude Code', command: 'claude', cwd: '/tmp',
  orch: false, role: null, position: { x: 10, y: 20 }, size: { width: 640, height: 420 }
})
const browser = (id: string, name: string, url = 'https://example.test'): BrowserNodeData => ({
  kind: 'browser', id, name, url, position: { x: 700, y: 20 }, size: { width: 720, height: 560 }
})
const request = (args: string[], terminalId: string, flags: CliRequest['flags'] = {}): CliRequest =>
  ({ id: 'r1', cmd: 'browser', args, flags, terminalId })

/** The caller lives in "GOAT"; "Cookrew" is what the window shows. */
function setup() {
  const store = new WorkspaceStore(
    path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-browser-any-')), 'data'),
    { multiInstance: true }
  )
  const goat = store.focusedId
  store.renameWorkspace(goat, 'GOAT')
  const me = store.addNode(terminal('t-shots', 'D1-Shots')) as TerminalNodeData
  const cookrew = store.createWorkspace('Cookrew', '/tmp').id
  const browserCommand = vi.fn((_args: string[], _id: string) => Promise.resolve('delegated'))
  const signal = vi.fn()
  const createBrowserInWorkspace = vi.fn()
  const deps = {
    store,
    browserCommand,
    createBrowserInWorkspace,
    signal,
    browserAnyWorkspace: () => true,
    listWorkspaces: () => store.list(),
    isServed: () => false
  } as unknown as SocketServerDeps
  return { store, deps, browserCommand, signal, createBrowserInWorkspace, me, goat, cookrew }
}

describe('cmdBrowser on the headless engine — the window shows another workspace', () => {
  it('drives the caller\'s own card instead of refusing it', async () => {
    const { store, deps, browserCommand, me, cookrew } = setup()
    const shots = store.addNode(browser('b-shots', 'Solis-Shots')) as BrowserNodeData
    store.connect(me.id, shots.id)
    store.switchWorkspace(cookrew)

    await expect(cmdBrowser(request(['fill', 'Solis-Shots', '#email', 'a@b.c'], me.id), deps)).resolves.toBe('delegated')
    expect(browserCommand).toHaveBeenCalledWith(['fill', 'Solis-Shots', '#email', 'a@b.c'], me.id)
  })

  it('wires and signals an unwired card of the caller\'s own canvas', async () => {
    const { store, deps, signal, me, goat, cookrew } = setup()
    const page = store.addNode(browser('b-page', 'Page')) as BrowserNodeData
    store.switchWorkspace(cookrew)

    await cmdBrowser(request(['click', 'Page', '#go'], me.id), deps)
    expect(store.workspaceState(goat).connections).toEqual(
      expect.arrayContaining([expect.objectContaining({ a: me.id, b: page.id })])
    )
    expect(signal).toHaveBeenCalledWith({ from: me.id, to: page.id, kind: 'write' })
  })

  it.each(['screenshot', 'tap', 'status', 'tabs'])('`%s` on a card of its own canvas wires it, whatever is on screen', async (verb) => {
    const { store, deps, me, goat, cookrew } = setup()
    const page = store.addNode(browser('b-page', 'Page')) as BrowserNodeData
    store.switchWorkspace(cookrew)
    await cmdBrowser(request([verb, 'Page'], me.id), deps)
    expect(store.workspaceState(goat).connections).toEqual(
      expect.arrayContaining([expect.objectContaining({ a: me.id, b: page.id })])
    )
  })

  it('wires before the verb runs, so a use that is refused still counts', async () => {
    const { store, deps, browserCommand, me, goat } = setup()
    const page = store.addNode(browser('b-page', 'Page')) as BrowserNodeData
    browserCommand.mockRejectedValueOnce(new Error('Take a screenshot first'))
    await expect(cmdBrowser(request(['tap', 'Page', '1', '1'], me.id), deps)).rejects.toThrow('screenshot')
    expect(store.workspaceState(goat).connections).toEqual(
      expect.arrayContaining([expect.objectContaining({ a: me.id, b: page.id })])
    )
  })

  it('lights the cable for the screen verbs too', async () => {
    const { store, deps, signal, me } = setup()
    const page = store.addNode(browser('b-page', 'Page')) as BrowserNodeData
    await cmdBrowser(request(['screenshot', 'Page'], me.id), deps)
    expect(signal).toHaveBeenCalledWith({ from: page.id, to: me.id, kind: 'read' })
  })

  it('a served caller is never wired by using something', async () => {
    const { store, deps, me } = setup()
    const page = store.addNode(browser('b-page', 'Page')) as BrowserNodeData
    store.connect(me.id, page.id)
    const other = store.addNode(browser('b-other', 'Other')) as BrowserNodeData
    const served = { ...deps, isServed: () => true } as SocketServerDeps
    await cmdBrowser(request(['tap', 'Page', '1', '1'], me.id), served).catch(() => undefined)
    await cmdBrowser(request(['tap', 'Other', '1', '1'], me.id), served).catch(() => undefined)
    expect(store.isConnected(me.id, other.id)).toBe(false)
  })

  it('never wires a card of the workspace on screen it was not wired to', async () => {
    const { store, deps, me, cookrew } = setup()
    store.switchWorkspace(cookrew)
    const theirs = store.addNode(browser('b-theirs', 'Theirs')) as BrowserNodeData

    await cmdBrowser(request(['click', 'Theirs', '#go'], me.id), deps)
    expect(store.workspaceState(cookrew).connections.some((c) => c.b === theirs.id || c.a === theirs.id)).toBe(false)
  })

  it('create runs the engine now, in the caller\'s workspace — not "when it is shown"', async () => {
    const { store, deps, browserCommand, createBrowserInWorkspace, me, cookrew } = setup()
    store.switchWorkspace(cookrew)

    await expect(cmdBrowser(request(['create', 'https://example.test', 'Fresh'], me.id), deps)).resolves.toBe('delegated')
    expect(browserCommand).toHaveBeenCalledWith(['create', 'https://example.test', 'Fresh'], me.id)
    expect(createBrowserInWorkspace).not.toHaveBeenCalled()
  })

  it('create adopts a same-named card of the caller\'s canvas while another is shown', async () => {
    const { store, deps, browserCommand, me, goat, cookrew } = setup()
    const shots = store.addNode(browser('b-shots', 'Solis-Shots', 'https://old.test')) as BrowserNodeData
    store.switchWorkspace(cookrew)

    await expect(
      cmdBrowser(request(['create', 'https://new.test', 'Solis-Shots'], me.id), deps)
    ).resolves.toMatch(/already exists in "GOAT".*now wired to you, navigated/)
    expect(browserCommand).toHaveBeenCalledWith(['navigate', 'Solis-Shots', 'https://new.test'], me.id)
    expect(store.workspaceState(goat).connections).toEqual(
      expect.arrayContaining([expect.objectContaining({ a: me.id, b: shots.id })])
    )
  })

  it('still refuses to make a card in a workspace that is not the caller\'s', async () => {
    const { deps, browserCommand, me } = setup()
    await expect(
      cmdBrowser(request(['create', 'https://example.test', 'X'], me.id, { workspace: 'Cookrew' }), deps)
    ).rejects.toThrow(/only make cards in your own workspace/)
    expect(browserCommand).not.toHaveBeenCalled()
  })

  it('a caller no workspace holds keeps the old create: a named workspace gets a stored card', async () => {
    // Review finding: --workspace was validated, then ignored, and the card
    // landed on the canvas on screen.
    const { deps, browserCommand, createBrowserInWorkspace, cookrew } = setup()
    createBrowserInWorkspace.mockReturnValue({ name: 'X', adopted: false })
    const homeless = { ...request(['create', 'https://example.test', 'X'], '', { workspace: 'Cookrew', as: 'Ghost' }) }
    ;(deps as unknown as { agents: unknown }).agents = {
      list: () => [{ id: 'ghost', name: 'Ghost', preset: 'Claude Code', command: 'claude', cwd: '/tmp', orch: false, role: null, active: true }],
      lookup: () => undefined
    }
    await expect(cmdBrowser(homeless, deps)).resolves.toMatch(/Created browser "X" in workspace "Cookrew"/)
    expect(createBrowserInWorkspace).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: cookrew }))
    expect(browserCommand).not.toHaveBeenCalled()
  })

  it('signals the card resolved BEFORE the command ran', async () => {
    const { store, deps, signal, browserCommand, me, cookrew } = setup()
    const page = store.addNode(browser('b-page', 'Page')) as BrowserNodeData
    store.connect(me.id, page.id)
    store.switchWorkspace(cookrew)
    browserCommand.mockImplementation(async () => {
      store.updateNode(page.id, { name: 'Renamed' })
      return 'delegated'
    })
    await cmdBrowser(request(['click', 'Page', '#go'], me.id), deps)
    expect(signal).toHaveBeenCalledWith({ from: me.id, to: page.id, kind: 'write' })
  })

  it('a served caller reaches only its wires', async () => {
    const { store, deps, browserCommand, me, cookrew } = setup()
    store.addNode(browser('b-own', 'Own'))
    store.switchWorkspace(cookrew)
    ;(deps as unknown as { isServed: () => boolean }).isServed = () => true
    await cmdBrowser(request(['click', 'Own', '#go'], me.id), deps)
    expect(store.workspaceState(store.ownerOf(me.id) as string).connections).toHaveLength(0)
    expect(browserCommand).toHaveBeenCalled()
  })
})
