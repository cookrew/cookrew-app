// Trusted agent-command adapter for node-owned headless browsers.
//
// This is intentionally separate from the LAN WebSocket input surface. Agent
// commands are local, authenticated through Cookrew's terminal socket and may
// evaluate page JavaScript; WS clients remain limited to sanitizeInput.

import { randomUUID } from 'node:crypto'
import type { BrowserNodeData, BrowserTab, CanvasNode } from '../shared/model'
import { activeBrowserTab, browserTabs } from '../shared/model'
import type { WorkspaceStore } from './store'
import type { HeadlessBrowserManager } from './headless-browser-manager'
import type { HeadlessInstance } from './headless-chrome'

export interface HeadlessBrowserCommandDeps {
  store: WorkspaceStore
  manager: HeadlessBrowserManager
  addNode: (node: CanvasNode) => CanvasNode
  updateNode: (id: string, patch: Partial<CanvasNode>) => CanvasNode | undefined
  connectNodes: (aId: string, bId: string) => void
}

const SNAPSHOT_SCRIPT = `(() => {
  const SALIENT = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[onclick],h1,h2,h3,label,summary'
  const out = []
  let n = 0
  for (const el of document.querySelectorAll(SALIENT)) {
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue
    if (rect.bottom < 0 || rect.top > innerHeight * 3) continue
    n += 1
    const ref = 'e' + n
    el.setAttribute('data-cookrew-ref', ref)
    const tag = el.tagName.toLowerCase()
    const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '')
      .trim().replace(/\\s+/g, ' ').slice(0, 60)
    const attrs = []
    if (tag === 'input') attrs.push('type=' + (el.type || 'text'))
    if (tag === 'a' && el.href) attrs.push('href=' + el.href.slice(0, 80))
    if (document.activeElement === el) attrs.push('*focused*')
    out.push('@' + ref + ' ' + tag + ' "' + text + '"' + (attrs.length ? ' ' + attrs.join(' ') : '') +
      ' [' + Math.round(rect.x) + ',' + Math.round(rect.y) + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ']')
  }
  return 'viewport: ' + innerWidth + 'x' + innerHeight + '  url: ' + location.href + '  title: ' + document.title + '\\n' + out.join('\\n')
})()`

function selectorFor(selector: string): string {
  if (selector.startsWith('@')) {
    return `document.querySelector('[data-cookrew-ref="${selector.slice(1)}"]')`
  }
  if (/^\d+,\d+$/.test(selector)) {
    const [x, y] = selector.split(',')
    return `document.elementFromPoint(${x}, ${y})`
  }
  return `document.querySelector(${JSON.stringify(selector)})`
}

async function withElement(
  instance: HeadlessInstance,
  selector: string,
  action: string
): Promise<string> {
  const result = await instance.evaluate(`(() => {
    const el = ${selectorFor(selector)}
    if (!el) return '__COOKREW_NOT_FOUND__'
    ${action}
  })()`)
  if (result === '__COOKREW_NOT_FOUND__') {
    throw new Error(`Element '${selector}' not found - re-run snapshot`)
  }
  return typeof result === 'string' ? result : JSON.stringify(result) ?? 'OK'
}

export class HeadlessBrowserCommandEngine {
  constructor(private readonly deps: HeadlessBrowserCommandDeps) {}

  async run(args: string[], terminalId: string): Promise<string> {
    const [sub, ...rest] = args
    if (sub === 'create') return this.create(rest, terminalId)

    const browserName = rest[0]
    if (!browserName) throw new Error(`Usage: cookrew browser ${sub} "Browser" ...`)
    const node = this.findBrowser(browserName)
    if (TAB_COMMANDS.has(sub)) return this.runTabCommand(sub, node, rest.slice(1))

    const instance = await this.requireInstance(node)
    const params = rest.slice(1)
    switch (sub) {
      case 'snapshot':
        return String(await instance.evaluate(SNAPSHOT_SCRIPT))
      case 'navigate': {
        const url = params[0]
        if (!url) throw new Error(`Usage: cookrew browser navigate "${browserName}" URL`)
        await instance.navigate(url)
        return `Navigated to ${url}`
      }
      case 'info': {
        const info = await instance.pageInfo()
        return `url: ${info.url}\ntitle: ${info.title}\nviewport: ${info.viewport}`
      }
      case 'click':
        return withElement(instance, params[0], `el.click(); return 'Clicked'`)
      case 'fill':
        return withElement(
          instance,
          params[0],
          `el.focus(); el.value = ${JSON.stringify(params[1] ?? '')};
           el.dispatchEvent(new Event('input', { bubbles: true }));
           el.dispatchEvent(new Event('change', { bubbles: true }));
           return 'Filled'`
        )
      case 'type':
        return withElement(
          instance,
          params.length > 1 ? params[0] : ':focus',
          `el.focus(); el.value = (el.value || '') + ${JSON.stringify(params[params.length - 1] ?? '')};
           el.dispatchEvent(new Event('input', { bubbles: true }));
           return 'Typed'`
        )
      case 'key':
        return String(
          await instance.evaluate(`(() => {
            const key = ${JSON.stringify(params[0] ?? 'Enter')}
            const el = document.activeElement || document.body
            for (const type of ['keydown', 'keypress', 'keyup']) {
              el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }))
            }
            if (key === 'Enter' && el.form) el.form.requestSubmit()
            return 'Pressed ' + key
          })()`)
        )
      case 'text':
        return withElement(instance, params[0] ?? 'body', 'return el.innerText.slice(0, 20000)')
      case 'html':
        return String(
          await instance.evaluate('document.documentElement.outerHTML.slice(0, 100000)')
        )
      case 'evaluate':
        return String(await instance.evaluate(params[0] ?? ''))
      case 'scroll': {
        const direction = params[0] ?? 'down'
        const amount = Number.parseInt(params[1] ?? '300', 10)
        const [dx, dy] =
          direction === 'down'
            ? [0, amount]
            : direction === 'up'
              ? [0, -amount]
              : direction === 'right'
                ? [amount, 0]
                : [-amount, 0]
        await instance.evaluate(`scrollBy(${dx}, ${dy})`)
        return `Scrolled ${direction} ${amount}`
      }
      default:
        throw new Error(`Unknown browser command '${sub}'`)
    }
  }

  private async create(params: string[], terminalId: string): Promise<string> {
    const [url, requestedName] = params
    if (!url) throw new Error('Usage: cookrew browser create URL ["Name"]')
    const terminal = this.deps.store.node(terminalId)
    const base = terminal?.position ?? { x: 0, y: 0 }
    const width = terminal?.size.width ?? 640
    const id = randomUUID()
    const tab: BrowserTab = { id: randomUUID(), url, title: '' }
    const node: BrowserNodeData = {
      kind: 'browser',
      id,
      name: requestedName || 'Browser',
      url,
      tabs: [tab],
      activeTabId: tab.id,
      position: { x: base.x + width + 80, y: base.y },
      size: { width: 720, height: 560 }
    }
    const added = this.deps.addNode(node) as BrowserNodeData
    this.deps.connectNodes(terminalId, added.id)
    await this.deps.manager.syncNode(added)
    return `Created browser "${added.name}"`
  }

  private findBrowser(name: string): BrowserNodeData {
    const node = this.deps.store.nodeByName(name, 'browser')
    if (!node || node.kind !== 'browser') {
      throw new Error(`Browser '${name}' not found. Run 'cookrew list'.`)
    }
    return node
  }

  private async requireInstance(node: BrowserNodeData): Promise<HeadlessInstance> {
    const instance = await this.deps.manager.syncNode(node)
    if (!instance) throw new Error(`Headless browser '${node.name}' is unavailable`)
    return instance
  }

  private async runTabCommand(
    sub: string,
    node: BrowserNodeData,
    params: string[]
  ): Promise<string> {
    const tabs = browserTabs(node)
    const active = activeBrowserTab(node)
    if (sub === 'tabs') {
      return tabs
        .map(
          (tab, index) =>
            `${index + 1}. ${tab.title || '(untitled)'} - ${tab.url}${tab.id === active.id ? ' (active)' : ''}`
        )
        .join('\n')
    }

    if (sub === 'tab-new') {
      const url = params[0]
      if (!url) throw new Error(`Usage: cookrew browser tab-new "${node.name}" URL`)
      const tab: BrowserTab = { id: randomUUID(), url, title: '' }
      const updated = this.patch(node.id, {
        tabs: [...tabs, tab],
        activeTabId: tab.id,
        url
      })
      await this.deps.manager.syncNode(updated)
      return `Opened tab ${tabs.length + 1} (${url})`
    }

    const index = Number.parseInt(params[0] ?? '', 10)
    if (!Number.isInteger(index) || index < 1 || index > tabs.length) {
      throw new Error(
        `Usage: cookrew browser ${sub} "${node.name}" N (1-${tabs.length}, see 'cookrew browser tabs')`
      )
    }
    const target = tabs[index - 1]

    if (sub === 'tab-select') {
      const updated = this.patch(node.id, { activeTabId: target.id, url: target.url })
      await this.deps.manager.syncNode(updated)
      return `Switched to tab ${index} (${target.url})`
    }

    if (sub === 'tab-close') {
      if (tabs.length === 1) throw new Error('Cannot close the last tab - close the browser instead')
      const remaining = tabs.filter((tab) => tab.id !== target.id)
      const nextActive =
        target.id === active.id
          ? remaining[Math.min(index - 1, remaining.length - 1)]
          : active
      const updated = this.patch(node.id, {
        tabs: remaining,
        activeTabId: nextActive.id,
        url: nextActive.url
      })
      await this.deps.manager.syncNode(updated)
      return `Closed tab ${index}`
    }

    throw new Error(`Unknown browser command '${sub}'`)
  }

  private patch(id: string, patch: Partial<BrowserNodeData>): BrowserNodeData {
    const updated = this.deps.updateNode(id, patch as Partial<CanvasNode>)
    if (!updated || updated.kind !== 'browser') throw new Error('Browser node disappeared')
    return updated
  }
}

const TAB_COMMANDS = new Set(['tabs', 'tab-new', 'tab-select', 'tab-close'])
