// Trusted agent-command adapter for node-owned headless browsers.
//
// This is intentionally separate from the LAN WebSocket input surface. Agent
// commands are local, authenticated through Cookrew's terminal socket and may
// evaluate page JavaScript; WS clients remain limited to sanitizeInput.

import { randomUUID } from 'node:crypto'
import type { BrowserNodeData, BrowserTab, CanvasNode } from '../shared/model'
import { activeBrowserTab, browserTabs } from '../shared/model'
import type { WorkspaceStore } from './store'
import { backingOf, type HeadlessBrowserManager } from './headless-browser-manager'
import type { BrowserInstance } from './browser-instance'
import { parseUseUrl } from '../shared/use-url'
import type { UseSignal } from '../shared/use-signal'
import { handlesUseCommand, runUseCommand } from './use-commands'

export interface HeadlessBrowserCommandDeps {
  store: WorkspaceStore
  manager: HeadlessBrowserManager
  /** Add a card to a workspace; without one, to the canvas on screen. */
  addNode: (node: CanvasNode, workspaceId?: string) => CanvasNode
  updateNode: (id: string, patch: Partial<CanvasNode>) => CanvasNode | undefined
  connectNodes: (aId: string, bId: string) => void
  /** Every acting command, as the cursor the owner watches (shared/use-signal.ts). */
  onUse?: (signal: UseSignal) => void
  /** Where `screenshot` without a file name saves. */
  shotsDir?: string
  now?: () => number
  /**
   * The card a name means for THIS caller (browser-reach.ts) — its own
   * workspace first, whatever the window shows. Absent: the canvas on screen.
   */
  resolveBrowser?: (name: string, terminalId: string) => BrowserNodeData | undefined
  /** The workspace holding a terminal, where its new cards go. Absent: on screen. */
  homeOf?: (terminalId: string) => string | undefined
}

/** The centre of the element a selector names, in viewport points — where the cursor goes for a DOM action. */
const CENTER_OF = (selector: string): string => `(() => {
  const el = ${selectorFor(selector)}
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: innerWidth, h: innerHeight }
})()`

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

/**
 * Set a form field's value the way a keystroke does.
 *
 * React (and every framework copying its value tracker) keeps an OWN `value`
 * accessor on a controlled input that records each write. A plain
 * `el.value = x` goes through it, so the `input` event that follows compares
 * equal, onChange never fires, the framework's state stays empty and its next
 * render puts the empty value back — the Solis login e-mail that emptied
 * itself between two commands (2026-11-04). Writing through the PROTOTYPE's
 * setter skips the tracker. Anything without a native value setter (a
 * contenteditable) keeps the plain assignment.
 */
const SET_VALUE = `((el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null
  const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : undefined
  if (setter) setter.call(el, value)
  else el.value = value
})`

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
  instance: BrowserInstance,
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
    const node = this.findBrowser(browserName, terminalId)
    if (sub === 'tabs') return this.runTabCommand(sub, node, rest.slice(1))

    // ANOTHER DEVICE IS A NEW ADDRESS FOR THE CARD, not a page for the old device
    // to open: the card's tab is re-addressed and the manager swaps the instance
    // (its viewers redial onto the new one). Before any instance is asked for: a
    // page card on a machine with no Chrome has none, and this needs none.
    if (sub === 'navigate' && rest[1] !== undefined && parseUseUrl(rest[1]) !== null) {
      const url = rest[1]
      const readdressed = withActiveUrl(node, url)
      if (backingOf(readdressed) !== backingOf(node)) {
        this.deps.onUse?.({ agent: terminalId, card: node.id, use: 'browser', verb: 'navigate', point: null, viewport: null, at: (this.deps.now ?? Date.now)() })
        const updated = this.patch(node.id, { url, tabs: readdressed.tabs })
        await this.deps.manager.syncNode(updated)
        return `Re-addressed to ${url}`
      }
    }

    const instance = await this.requireInstance(node)
    const releaseViewport = await instance.beginAgentViewportActivity()
    try {
      if (TAB_COMMANDS.has(sub)) return this.runTabCommand(sub, node, rest.slice(1))
      const params = rest.slice(1)
      const target = parseUseUrl(activeBrowserTab(node).url)
      if (handlesUseCommand(sub, instance)) {
        return await runUseCommand(sub, params, instance, {
          agent: terminalId,
          card: node.id,
          cardName: node.name,
          target,
          shotsDir: this.deps.shotsDir ?? '/tmp/cookrew-shots',
          now: this.deps.now ?? Date.now,
          emit: (signal) => this.deps.onUse?.(signal)
        })
      }
      if (sub === 'click' || sub === 'fill' || (sub === 'type' && params.length > 1)) {
        await this.signalAt(instance, node.id, terminalId, sub, params[0])
      } else if (sub === 'navigate') {
        this.deps.onUse?.({ agent: terminalId, card: node.id, use: 'browser', verb: 'navigate', point: null, viewport: null, at: (this.deps.now ?? Date.now)() })
      }
      switch (sub) {
        case 'snapshot':
          return String(await instance.evaluate(SNAPSHOT_SCRIPT))
        case 'navigate': {
          const url = params[0]
          if (!url) throw new Error(`Usage: cookrew browser navigate "${browserName}" URL`)
          // A web address on a phone still opens in the phone's browser.
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
            `el.focus(); ${SET_VALUE}(el, ${JSON.stringify(params[1] ?? '')});
             el.dispatchEvent(new Event('input', { bubbles: true }));
             el.dispatchEvent(new Event('change', { bubbles: true }));
             return 'Filled'`
          )
        case 'type':
          return withElement(
            instance,
            params.length > 1 ? params[0] : ':focus',
            `el.focus(); ${SET_VALUE}(el, (el.value || '') + ${JSON.stringify(params[params.length - 1] ?? '')});
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
    } finally {
      releaseViewport()
    }
  }

  private async create(params: string[], terminalId: string): Promise<string> {
    const [url, requestedName] = params
    if (!url) throw new Error('Usage: cookrew browser create URL ["Name"] [--workspace <name>] [--new]')
    // The card goes to the caller's own workspace (homeOf), on screen or not,
    // anchored beside its caller and wired to it. A caller no workspace holds
    // at all — a terminal resolved from the durable registry after a reboot —
    // has no position to anchor to and cannot own an edge, so its browser is
    // created on the canvas on screen, unconnected, and says so, instead of
    // writing an edge to an id that exists nowhere.
    const home = this.deps.homeOf?.(terminalId)
    const terminal =
      this.deps.store.node(terminalId) ??
      (home === undefined ? undefined : this.deps.store.nodeAcrossWorkspaces?.(terminalId)?.node)
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
    const added = this.deps.addNode(node, home) as BrowserNodeData
    if (terminal) this.deps.connectNodes(terminalId, added.id)
    await this.deps.manager.syncNode(added)
    return terminal
      ? `Created browser "${added.name}"`
      : `Created browser "${added.name}" (not connected: your terminal is not a node in this workspace)`
  }

  /** The cursor for a DOM action: the element's centre. Best effort — a miss never blocks the action. */
  private async signalAt(instance: BrowserInstance, card: string, agent: string, verb: string, selector: string | undefined): Promise<void> {
    if (!this.deps.onUse || !selector) return
    type Center = { x: number; y: number; w: number; h: number }
    const at = await instance.evaluate(CENTER_OF(selector)).then(
      (value) => (value ?? null) as Center | null,
      () => null
    )
    this.deps.onUse({
      agent,
      card,
      use: 'browser',
      verb,
      point: at ? { x: at.x, y: at.y } : null,
      viewport: at ? { width: at.w, height: at.h } : null,
      at: (this.deps.now ?? Date.now)()
    })
  }

  private findBrowser(name: string, terminalId: string): BrowserNodeData {
    const node = this.deps.resolveBrowser
      ? this.deps.resolveBrowser(name, terminalId)
      : this.deps.store.nodeByName(name, 'browser')
    if (!node || node.kind !== 'browser') {
      throw new Error(`Browser '${name}' not found. Run 'cookrew list'.`)
    }
    return node
  }

  private async requireInstance(node: BrowserNodeData): Promise<BrowserInstance> {
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

/** The card with its active tab pointed at `url` — what it would be, re-addressed. */
export function withActiveUrl(node: BrowserNodeData, url: string): BrowserNodeData {
  const active = activeBrowserTab(node)
  return { ...node, url, tabs: browserTabs(node).map((tab) => (tab.id === active.id ? { ...tab, url, title: '' } : tab)) }
}
