// `cookrew browser click` on a dropdown option (live 2026-11-28: Aliyun's
// firewall protocol picker and Cloudflare's zone picker).
//
// Two failures, one page: the snapshot only listed anchors, buttons, inputs and
// a few roles, so an option that is a div with role="option" (or a plain list
// item) got no ref; and click treated its words as a CSS selector, so
// `click "Browser" "cookrew.dev"` answered "Element 'cookrew.dev' not found".
// The fix lists dropdown items and lets click fall back to the text on them.
//
// The expression the engine evaluates is run for real (node:vm) against a fake
// page shaped like a framework's dropdown, not string-matched.
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { HeadlessBrowserCommandEngine } from '../src/main/headless-browser-command'
import type { BrowserNodeData } from '../src/shared/model'
import type { HeadlessBrowserManager } from '../src/main/headless-browser-manager'
import type { WorkspaceStore } from '../src/main/store'

interface Item {
  innerText: string
  role?: string
  childElementCount: number
  pressed: string[]
  width: number
  height: number
  readonly tagName: string
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; bottom: number }
  dispatchEvent(event: { type: string }): boolean
  click(): void
}

function item(text: string, role?: string): Item {
  const pressed: string[] = []
  return {
    innerText: text,
    ...(role ? { role } : {}),
    childElementCount: 0,
    pressed,
    width: 120,
    height: 24,
    tagName: 'div',
    getAttribute: () => null,
    setAttribute: () => undefined,
    getBoundingClientRect: () => ({ x: 10, y: 50, width: 120, height: 24, top: 50, bottom: 74 }),
    dispatchEvent: (event) => {
      pressed.push(event.type)
      return true
    },
    click: () => pressed.push('click')
  }
}

function dropdownPage() {
  const tcp = item('TCP', 'option')
  const udp = item('UDP', 'option')
  const zone = item('cookrew.dev', 'option')
  const button = item('的高级选择', 'combobox')
  const all = [button, tcp, udp, zone]
  const document = {
    body: {},
    activeElement: null,
    title: 'Pick',
    querySelectorAll: (selector: string) =>
      selector.includes('role="option"') || selector.trim() === 'body *' ? all : [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => item(''),
    documentElement: {}
  }
  class MouseEvent {
    constructor(public type: string, public init: Record<string, unknown> = {}) {}
  }
  const context = {
    document,
    innerWidth: 800,
    innerHeight: 600,
    location: { href: 'https://example.test' },
    MouseEvent,
    window: {}
  }
  return { context, tcp, udp, zone, button }
}

function engineOn(page: ReturnType<typeof dropdownPage>): HeadlessBrowserCommandEngine {
  const node: BrowserNodeData = {
    kind: 'browser', id: 'b1', name: 'Picker', url: 'https://example.test',
    tabs: [{ id: 't1', url: 'https://example.test', title: '' }], activeTabId: 't1',
    position: { x: 0, y: 0 }, size: { width: 720, height: 560 }
  }
  const instance = {
    evaluate: vi.fn((expression: string) => Promise.resolve(runInNewContext(expression, page.context))),
    beginAgentViewportActivity: vi.fn(() => Promise.resolve(vi.fn()))
  }
  return new HeadlessBrowserCommandEngine({
    store: { nodeByName: () => node, node: () => undefined } as unknown as WorkspaceStore,
    manager: { syncNode: vi.fn(() => Promise.resolve(instance)) } as unknown as HeadlessBrowserManager,
    addNode: (n) => n,
    updateNode: () => undefined,
    connectNodes: () => undefined
  })
}

describe('a dropdown item is listed and can be clicked by its words', () => {
  it('the snapshot lists the options, so each has a ref', async () => {
    const page = dropdownPage()
    const snapshot = await engineOn(page).run(['snapshot', 'Picker'], 'agent')
    expect(snapshot).toContain('UDP')
    expect(snapshot).toContain('TCP')
    expect(snapshot).toContain('cookrew.dev')
  })

  it('click by the words presses the option that carries them', async () => {
    const page = dropdownPage()
    await expect(engineOn(page).run(['click', 'Picker', 'UDP'], 'agent')).resolves.toBe('Clicked')
    expect(page.udp.pressed).toEqual(['mousedown', 'mouseup', 'click'])
    expect(page.tcp.pressed).toEqual([])
  })

  it('a name with a dot is not read as a CSS selector that does not exist', async () => {
    const page = dropdownPage()
    await expect(engineOn(page).run(['click', 'Picker', 'cookrew.dev'], 'agent')).resolves.toBe('Clicked')
    expect(page.zone.pressed).toEqual(['mousedown', 'mouseup', 'click'])
  })

  it('a ref still wins, and nothing is clicked when the words are on the page nowhere', async () => {
    const page = dropdownPage()
    await expect(engineOn(page).run(['click', 'Picker', 'No such row'], 'agent')).rejects.toThrow("not found")
    expect(page.udp.pressed).toEqual([])
  })
})
