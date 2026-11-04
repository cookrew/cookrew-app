// `cookrew browser fill/type` against a framework-controlled input.
//
// Live 2026-11-04: D1-Shots filled the Solis login e-mail, the field emptied
// itself before the next command and "Send Code" never enabled. React keeps a
// value tracker as an OWN `value` property on the element: a plain
// `el.value = x` writes through the tracker, so the following `input` event
// compares equal and onChange never fires — React's state stays empty and its
// next render puts the empty value back. Writing through the PROTOTYPE setter
// bypasses the tracker, which is how a real keystroke looks to React.
//
// The fake element below reproduces exactly that tracker contract, so the
// expression the engine evaluates is run for real (node:vm), not string-matched.
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { HeadlessBrowserCommandEngine } from '../src/main/headless-browser-command'
import type { HeadlessBrowserManager } from '../src/main/headless-browser-manager'
import type { BrowserNodeData } from '../src/shared/model'
import type { WorkspaceStore } from '../src/main/store'

function reactLikePage(): { context: Record<string, unknown>; changes: string[]; input: { value: string } } {
  const changes: string[] = []
  class HTMLElement {}
  class HTMLInputElement extends HTMLElement {
    raw = ''
    tracked = ''
    listeners: Record<string, Array<() => void>> = {}
    get value(): string { return this.raw }
    set value(next: string) { this.raw = next }
    focus(): void {}
    addEventListener(type: string, fn: () => void): void { (this.listeners[type] ??= []).push(fn) }
    dispatchEvent(event: { type: string }): boolean {
      for (const fn of this.listeners[event.type] ?? []) fn()
      return true
    }
  }
  class HTMLTextAreaElement extends HTMLElement {}
  class HTMLSelectElement extends HTMLElement {}
  const input = new HTMLInputElement()
  // React's inputValueTracking: an own accessor that records what was set.
  Object.defineProperty(input, 'value', {
    configurable: true,
    get(this: HTMLInputElement) { return this.raw },
    set(this: HTMLInputElement, next: string) { this.tracked = next; this.raw = next }
  })
  // React's onChange: fires only when the DOM value differs from the tracker.
  input.addEventListener('input', () => {
    if (input.raw !== input.tracked) {
      input.tracked = input.raw
      changes.push(input.raw)
    }
  })
  const document = { querySelector: () => input, activeElement: input, body: input }
  class Event { constructor(public type: string) {} }
  return {
    context: { document, Event, HTMLElement, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, Object },
    changes,
    input
  }
}

function engineOn(page: ReturnType<typeof reactLikePage>): HeadlessBrowserCommandEngine {
  const node: BrowserNodeData = {
    kind: 'browser', id: 'b1', name: 'Login', url: 'https://example.test',
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

describe('fill/type reach a framework-controlled input', () => {
  it('fill fires the framework change with the new value', async () => {
    const page = reactLikePage()
    await expect(engineOn(page).run(['fill', 'Login', '#email', 'owner@example.com'], 'agent')).resolves.toBe('Filled')
    expect(page.changes).toEqual(['owner@example.com'])
    expect(page.input.value).toBe('owner@example.com')
  })

  it('type appends and fires the framework change', async () => {
    const page = reactLikePage()
    const engine = engineOn(page)
    await engine.run(['fill', 'Login', '#email', 'owner@'], 'agent')
    await expect(engine.run(['type', 'Login', '#email', 'example.com'], 'agent')).resolves.toBe('Typed')
    expect(page.changes).toEqual(['owner@', 'owner@example.com'])
  })
})
