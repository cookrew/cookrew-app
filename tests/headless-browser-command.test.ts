import { mkdtempSync } from 'node:fs'
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
      connectNodes: (a, b) => void store.connect(a, b)
    })
  })

  it('runs trusted agent evaluation on the node-owned headless instance', async () => {
    await expect(
      engine.run(['evaluate', 'Shared', 'sessionStorage.token'], terminal().id)
    ).resolves.toBe('shared-token')
    expect(manager.syncNode).toHaveBeenCalledWith(expect.objectContaining({ id: browser().id }))
    expect(instance.evaluate).toHaveBeenCalledWith('sessionStorage.token')
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
})
