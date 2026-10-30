// A SERVED CALLER NEVER REACHES THE OWNER'S SCREENS, CAMERAS OR PHONES.
//
// Served panes run a caller's work under Seatbelt; the uses run in main with
// the owner's grants. Through the real CLI handler (cmdBrowser): a served
// terminal is refused every route onto a use card, before the engine is
// asked anything, while the owner's own terminal is not, and a served
// caller's ordinary web browsing still works.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cmdBrowser, type SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import { SERVED_USE_REFUSED } from '../src/main/use-commands'
import type { BrowserNodeData, CliRequest, TerminalNodeData } from '../src/shared/model'

const terminal = (id: string): TerminalNodeData => ({
  kind: 'terminal', id, name: id, preset: 'Claude Code', command: 'claude', cwd: '/tmp',
  orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 640, height: 420 }
})
const card = (id: string, name: string, url: string): BrowserNodeData => ({
  kind: 'browser', id, name, url, tabs: [{ id: `${id}-t`, url, title: '' }], activeTabId: `${id}-t`,
  position: { x: 0, y: 0 }, size: { width: 720, height: 560 }
})
const request = (args: string[], terminalId: string): CliRequest => ({ id: 'r', cmd: 'browser', args, flags: {}, terminalId }) as CliRequest

function setup() {
  const store = new WorkspaceStore(path.join(mkdtempSync(path.join(tmpdir(), 'served-gate-')), 'data'))
  store.addNode(terminal('owner'))
  store.addNode(terminal('caller'))
  store.addNode(card('w', 'Web', 'https://a.test'))
  store.addNode(card('p', 'Phone', 'adb://default'))
  const browserCommand = vi.fn(() => Promise.resolve('done'))
  const deps = { store, browserCommand, listWorkspaces: () => store.list(), isServed: (id: string) => id === 'caller' } as unknown as SocketServerDeps
  return { deps, browserCommand }
}

describe('cmdBrowser · served callers and uses', () => {
  it('refuses a served caller every route onto a use card, before the engine', async () => {
    const { deps, browserCommand } = setup()
    for (const args of [
      ['create', 'screen://main', 'Desk'],
      ['create', 'cam://0'],
      ['navigate', 'Web', 'window://1Password'],
      ['tab-new', 'Web', 'adb://default'],
      ['screenshot', 'Phone'],
      ['tap', 'Phone', '10', '10']
    ]) {
      await expect(cmdBrowser(request(args, 'caller'), deps), args.join(' ')).rejects.toThrow(SERVED_USE_REFUSED)
    }
    expect(browserCommand).not.toHaveBeenCalled()
  })

  it('lets the owner use them, and lets a served caller browse the web', async () => {
    const { deps, browserCommand } = setup()
    await cmdBrowser(request(['screenshot', 'Phone'], 'owner'), deps)
    await cmdBrowser(request(['navigate', 'Web', 'https://b.test'], 'caller'), deps)
    expect(browserCommand).toHaveBeenCalledTimes(2)
  })
})
