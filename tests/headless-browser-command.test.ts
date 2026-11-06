import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserNodeData, TerminalNodeData } from '../src/shared/model'
import { WorkspaceStore } from '../src/main/store'
import { HeadlessBrowserCommandEngine } from '../src/main/headless-browser-command'
import type { HeadlessBrowserManager } from '../src/main/headless-browser-manager'
import type { HeadlessInstance } from '../src/main/headless-chrome'

function terminal(): TerminalNodeData {
  return {
    kind: 'terminal',
    id: 'agent-1',
    name: 'Agent',
    preset: 'Codex',
    command: 'codex',
    cwd: '/tmp',
    orch: true,
    role: null,
    position: { x: 10, y: 20 },
    size: { width: 640, height: 420 }
  }
}

function browser(): BrowserNodeData {
  return {
    kind: 'browser',
    id: 'browser-1',
    name: 'Shared',
    url: 'https://example.test',
    tabs: [{ id: 'tab-1', url: 'https://example.test', title: 'Example' }],
    activeTabId: 'tab-1',
    position: { x: 730, y: 20 },
    size: { width: 720, height: 560 }
  }
}

describe('HeadlessBrowserCommandEngine', () => {
  let store: WorkspaceStore
  let instance: HeadlessInstance
  let manager: HeadlessBrowserManager
  let engine: HeadlessBrowserCommandEngine

  beforeEach(() => {
    store = new WorkspaceStore(path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-browser-command-')), 'data'))
    store.addNode(terminal())
    store.addNode(browser())
    instance = {
      evaluate: vi.fn(() => Promise.resolve('shared-token')),
      navigate: vi.fn(() => Promise.resolve()),
      beginAgentViewportActivity: vi.fn(() => Promise.resolve(vi.fn())),
      pageInfo: vi.fn(() =>
        Promise.resolve({ url: 'https://example.test', title: 'Example', viewport: '720x560' })
      )
    } as unknown as HeadlessInstance
    manager = {
      syncNode: vi.fn(() => Promise.resolve(instance))
    } as unknown as HeadlessBrowserManager
    engine = new HeadlessBrowserCommandEngine({
      store,
      manager,
      addNode: (node) => store.addNode(node),
      updateNode: (id, patch) => store.updateNode(id, patch),
      connectNodes: (a, b) => void store.connectAcross(a, b)
    })
  })

  it('creates UNCONNECTED for a caller no workspace holds, instead of a dangling edge', async () => {
    // A registry-only terminal (post-reboot) has no node to anchor to. The old
    // code still wrote `connect(terminalId, browserId)`, leaving an edge whose
    // endpoint exists in no workspace. Create it, say it is unconnected, and
    // write no edge — rather than failing a flow that used to work.
    const output = await engine.run(['create', 'https://example.test', 'Ghost'], 'not-a-node')
    expect(output).toMatch(/not connected/i)
    expect(store.nodeByName('Ghost', 'browser')).toBeDefined()
    expect(store.focusedState.connections).toHaveLength(0)
  })

  it('places a created browser beside its caller and connects the two', async () => {
    await expect(
      engine.run(['create', 'https://example.test/new', 'Fresh'], terminal().id)
    ).resolves.toMatch(/Fresh/)
    const created = store.nodeByName('Fresh', 'browser') as BrowserNodeData
    expect(created.position).toEqual({ x: 10 + 640 + 80, y: 20 })
    expect(store.focusedState.connections).toEqual([
      expect.objectContaining({ a: terminal().id, b: created.id })
    ])
  })

  it('runs trusted agent evaluation on the node-owned headless instance', async () => {
    await expect(
      engine.run(['evaluate', 'Shared', 'sessionStorage.token'], terminal().id)
    ).resolves.toBe('shared-token')
    expect(manager.syncNode).toHaveBeenCalledWith(expect.objectContaining({ id: browser().id }))
    expect(instance.evaluate).toHaveBeenCalledWith('sessionStorage.token')
    expect(instance.beginAgentViewportActivity).toHaveBeenCalledTimes(1)
  })

  describe('downloads', () => {
    const withRoot = (peek: unknown = null): { root: string; run: () => Promise<string> } => {
      const root = mkdtempSync(path.join(tmpdir(), 'cookrew-card-downloads-'))
      const asked = new HeadlessBrowserCommandEngine({
        store,
        manager: { ...manager, syncNode: manager.syncNode, peek: vi.fn(() => peek) } as unknown as HeadlessBrowserManager,
        addNode: (node) => store.addNode(node),
        updateNode: (id, patch) => store.updateNode(id, patch),
        connectNodes: (a, b) => void store.connectAcross(a, b),
        downloadsRoot: root
      })
      return { root, run: () => asked.run(['downloads', 'Shared'], terminal().id) }
    }

    it('names the files of a card whose Chrome is asleep, without waking it', async () => {
      const { root, run } = withRoot()
      mkdirSync(path.join(root, browser().id))
      writeFileSync(path.join(root, browser().id, 'a.json'), '{}')
      await expect(run()).resolves.toContain(path.join(root, browser().id, 'a.json'))
      expect(manager.syncNode).not.toHaveBeenCalled()
    })

    it('says what is still arriving on a live card', async () => {
      const { run } = withRoot({ activeDownloads: () => [{ name: 'big.bin', receivedBytes: 1, totalBytes: 2 }] })
      await expect(run()).resolves.toBe('downloading big.bin (1 of 2 bytes)')
    })

    it('answers a card that cannot download, a use card has no such thing', async () => {
      const { root, run } = withRoot({})
      await expect(run()).resolves.toBe(`No downloads yet. They land in ${path.join(root, browser().id)}`)
    })
  })

  it('routes navigation to headless Chrome', async () => {
    await expect(
      engine.run(['navigate', 'Shared', 'https://cookrew.test/next'], terminal().id)
    ).resolves.toBe('Navigated to https://cookrew.test/next')
    expect(instance.navigate).toHaveBeenCalledWith('https://cookrew.test/next')
  })

  it('reconciles tab mutations through the same manager', async () => {
    await engine.run(['tab-new', 'Shared', 'https://cookrew.test/tab'], terminal().id)
    const updated = store.node(browser().id) as BrowserNodeData
    expect(updated.tabs).toHaveLength(2)
    expect(updated.url).toBe('https://cookrew.test/tab')
    expect(manager.syncNode).toHaveBeenLastCalledWith(updated)
  })

  it('creates the browser node before starting its headless owner', async () => {
    const output = await engine.run(
      ['create', 'https://cookrew.test', 'Created'],
      terminal().id
    )
    const created = store.browsers().find((node) => node.name === 'Created')
    expect(output).toBe('Created browser "Created"')
    expect(created).toBeDefined()
    expect(manager.syncNode).toHaveBeenLastCalledWith(created)
  })

  it('navigating to another device re-addresses the card; a web address goes to the device as before', async () => {
    const shared = store.nodeByName('Shared', 'browser') as BrowserNodeData
    expect(await engine.run(['navigate', 'Shared', 'adb://default'], 'agent-1')).toBe('Re-addressed to adb://default')
    const phone = store.node(shared.id) as BrowserNodeData
    expect(phone.url).toBe('adb://default')
    expect(phone.tabs?.[0].url).toBe('adb://default')
    expect(instance.navigate).not.toHaveBeenCalled()
    expect(manager.syncNode).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'adb://default' }))
    // On the phone card now: a web address opens on the phone, the card stays a phone.
    await engine.run(['navigate', 'Shared', 'https://example.org'], 'agent-1')
    expect(instance.navigate).toHaveBeenCalledWith('https://example.org')
    expect((store.node(shared.id) as BrowserNodeData).url).toBe('adb://default')
    // The same device again is not a re-address.
    await engine.run(['navigate', 'Shared', 'adb://default'], 'agent-1')
    expect(instance.navigate).toHaveBeenLastCalledWith('adb://default')
  })

  describe('a caller in a workspace that is not on screen (owner ruling 2026-11-04)', () => {
    // Every workspace works on its own: driving or making a browser card
    // follows the CALLER's workspace, never the canvas the window shows.
    function scopedEngine(): { engine: HeadlessBrowserCommandEngine; home: string; shown: string } {
      const home = store.focusedId
      const shown = store.createWorkspace('Shown', '/tmp').id
      store.switchWorkspace(shown)
      const scoped = new HeadlessBrowserCommandEngine({
        store,
        manager,
        addNode: (node, workspaceId) => store.addNode(node, workspaceId),
        updateNode: (id, patch) => store.updateNode(id, patch),
        connectNodes: (a, b) => void store.connectAcross(a, b),
        resolveBrowser: (name, terminalId) => {
          const ws = store.ownerOf(terminalId)
          if (ws === undefined) return undefined
          return store.workspaceState(ws).nodes.find(
            (n): n is BrowserNodeData => n.kind === 'browser' && n.name === name
          )
        },
        homeOf: (terminalId) => store.ownerOf(terminalId)
      })
      return { engine: scoped, home, shown }
    }

    it('drives a card of the caller\'s own workspace while another is shown', async () => {
      const { engine: scoped } = scopedEngine()
      await expect(scoped.run(['evaluate', 'Shared', 'document.title'], terminal().id)).resolves.toBe('shared-token')
      expect(manager.syncNode).toHaveBeenCalledWith(expect.objectContaining({ id: browser().id }))
    })

    it('creates the card in the caller\'s own workspace, beside it and wired', async () => {
      const { engine: scoped, home, shown } = scopedEngine()
      await expect(scoped.run(['create', 'https://example.test/x', 'Away'], terminal().id)).resolves.toMatch(/Away/)
      const made = store.workspaceState(home).nodes.find((n) => n.name === 'Away')
      expect(made).toBeDefined()
      expect(made?.position).toEqual({ x: 10 + 640 + 80, y: 20 })
      expect(store.workspaceState(shown).nodes.some((n) => n.name === 'Away')).toBe(false)
      expect(store.workspaceState(home).connections).toEqual(
        expect.arrayContaining([expect.objectContaining({ a: terminal().id, b: made?.id })])
      )
      expect(manager.syncNode).toHaveBeenCalledWith(expect.objectContaining({ name: 'Away' }))
    })
  })
})
