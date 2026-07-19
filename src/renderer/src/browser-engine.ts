import { useEffect } from 'react'
import { cookrew } from './api'
import { activeBrowserTab, browserTabs } from '../../shared/model'
import type { CanvasNode, BrowserNodeData, BrowserTab } from '../../shared/model'

type WebviewElement = HTMLElement & {
  loadURL: (url: string) => Promise<void>
  getURL: () => string
  getTitle: () => string
  getWebContentsId: () => number
  executeJavaScript: (code: string) => Promise<unknown>
}

interface RegisteredBrowser {
  id: string
  name: string
  activeTabId: string | null
  tabs: Map<string, WebviewElement>
}

const browsers = new Map<string, RegisteredBrowser>()

export function registerBrowserTab(
  browserId: string,
  browserName: string,
  tabId: string,
  webview: unknown
): void {
  const record = browsers.get(browserId) ?? {
    id: browserId,
    name: browserName,
    activeTabId: null,
    tabs: new Map<string, WebviewElement>()
  }
  record.name = browserName
  record.tabs.set(tabId, webview as WebviewElement)
  browsers.set(browserId, record)
}

export function unregisterBrowserTab(browserId: string, tabId: string): void {
  const record = browsers.get(browserId)
  if (!record) return
  record.tabs.delete(tabId)
  if (record.tabs.size === 0) browsers.delete(browserId)
}

export function setBrowserActiveTab(browserId: string, tabId: string): void {
  const record = browsers.get(browserId)
  if (record) record.activeTabId = tabId
}

/** Map a popup's source webContents back to the browser tab that opened it. */
export function findBrowserTabByWebContentsId(
  webContentsId: number
): { browserId: string; tabId: string } | null {
  for (const record of browsers.values()) {
    for (const [tabId, webview] of record.tabs) {
      try {
        if (webview.getWebContentsId() === webContentsId) return { browserId: record.id, tabId }
      } catch {
        // webview not attached yet — cannot be the popup source
      }
    }
  }
  return null
}

/** Active tab's webview for a browser; falls back to the first mounted tab. */
function findBrowser(name: string): { id: string; name: string; webview: WebviewElement } {
  const record = [...browsers.values()].find((p) => p.name.toLowerCase() === name.toLowerCase())
  if (!record) throw new Error(`Browser '${name}' not found. Run 'cookrew list'.`)
  const webview =
    (record.activeTabId ? record.tabs.get(record.activeTabId) : undefined) ??
    [...record.tabs.values()][0]
  if (!webview) throw new Error(`Browser '${name}' has no mounted tab yet — retry in a moment`)
  return { id: record.id, name: record.name, webview }
}

/** Poll until a freshly created tab's webview mounts, so follow-up commands hit it. */
async function waitForTabMount(browserId: string, tabId: string, timeoutMs = 10000): Promise<void> {
  const startedAt = Date.now()
  while (!browsers.get(browserId)?.tabs.has(tabId)) {
    if (Date.now() - startedAt > timeoutMs) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Webview methods throw until the element is attached and dom-ready has
 * fired. Poll a cheap probe so commands issued right after `browser create`
 * wait for the page instead of hanging.
 */
async function waitForReady(webview: WebviewElement, timeoutMs = 15000): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    try {
      webview.getURL()
      return
    } catch {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('Browser page is not ready (webview never reached dom-ready)')
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

/**
 * Injected into the page: walks the DOM, tags interactive/salient elements
 * with data-cookrew-ref, and returns "@eN tag "text" [x,y wxh]" lines.
 */
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
  webview: WebviewElement,
  selector: string,
  action: string
): Promise<string> {
  const code = `(() => {
    const el = ${selectorFor(selector)}
    if (!el) return '__COOKREW_NOT_FOUND__'
    ${action}
  })()`
  const result = await webview.executeJavaScript(code)
  if (result === '__COOKREW_NOT_FOUND__') throw new Error(`Element '${selector}' not found — re-run snapshot`)
  return typeof result === 'string' ? result : JSON.stringify(result) ?? 'OK'
}

async function createBrowser(url: string, name: string, terminalId: string): Promise<string> {
  const state = await cookrew().getWorkspace()
  const me = state.nodes.find((n) => n.id === terminalId)
  const base = me?.position ?? { x: 0, y: 0 }
  const width = me?.size.width ?? 640
  const browser: BrowserNodeData = {
    kind: 'browser',
    id: crypto.randomUUID(),
    name: name || 'Browser',
    url,
    position: { x: base.x + width + 80, y: base.y },
    size: { width: 720, height: 560 }
  }
  const added = (await cookrew().addNode(browser as CanvasNode)) as BrowserNodeData
  await cookrew().connectNodes(terminalId, added.id)
  return `Created browser "${added.name}"`
}

async function findBrowserNode(name: string): Promise<BrowserNodeData> {
  const state = await cookrew().getWorkspace()
  const node = state.nodes.find(
    (n): n is BrowserNodeData => n.kind === 'browser' && n.name.toLowerCase() === name.toLowerCase()
  )
  if (!node) throw new Error(`Browser '${name}' not found. Run 'cookrew list'.`)
  return node
}

/** Tab-group management: operates on the workspace model, not the webview. */
async function runTabCommand(sub: string, name: string, params: string[]): Promise<string> {
  const node = await findBrowserNode(name)
  const tabs = browserTabs(node)
  const active = activeBrowserTab(node)

  if (sub === 'tabs') {
    return tabs
      .map((t, i) => `${i + 1}. ${t.title || '(untitled)'} — ${t.url}${t.id === active.id ? ' (active)' : ''}`)
      .join('\n')
  }

  if (sub === 'tab-new') {
    const url = params[0]
    if (!url) throw new Error(`Usage: cookrew browser tab-new "${name}" URL`)
    const tab: BrowserTab = { id: crypto.randomUUID(), url, title: '' }
    await cookrew().updateNode(node.id, { tabs: [...tabs, tab], activeTabId: tab.id, url })
    await waitForTabMount(node.id, tab.id)
    setBrowserActiveTab(node.id, tab.id)
    return `Opened tab ${tabs.length + 1} (${url})`
  }

  const index = parseInt(params[0] ?? '', 10)
  if (!Number.isInteger(index) || index < 1 || index > tabs.length) {
    throw new Error(`Usage: cookrew browser ${sub} "${name}" N (1-${tabs.length}, see 'cookrew browser tabs')`)
  }
  const target = tabs[index - 1]

  if (sub === 'tab-select') {
    await cookrew().updateNode(node.id, { activeTabId: target.id, url: target.url })
    setBrowserActiveTab(node.id, target.id)
    return `Switched to tab ${index} (${target.url})`
  }

  if (sub === 'tab-close') {
    if (tabs.length === 1) throw new Error('Cannot close the last tab — close the browser instead')
    const remaining = tabs.filter((t) => t.id !== target.id)
    const nextActive =
      target.id === active.id ? remaining[Math.min(index - 1, remaining.length - 1)] : active
    await cookrew().updateNode(node.id, {
      tabs: remaining,
      activeTabId: nextActive.id,
      url: nextActive.url
    })
    setBrowserActiveTab(node.id, nextActive.id)
    return `Closed tab ${index}`
  }

  throw new Error(`Unknown browser command '${sub}'`)
}

const TAB_COMMANDS = new Set(['tabs', 'tab-new', 'tab-select', 'tab-close'])

async function runBrowserCommand(args: string[], terminalId: string): Promise<string> {
  const [sub, ...rest] = args
  if (sub === 'create') {
    const [url, name] = rest
    if (!url) throw new Error('Usage: cookrew browser create URL ["Name"]')
    return createBrowser(url, name ?? 'Browser', terminalId)
  }

  const browserName = rest[0]
  if (!browserName) throw new Error(`Usage: cookrew browser ${sub} "Browser" ...`)
  if (TAB_COMMANDS.has(sub)) return runTabCommand(sub, browserName, rest.slice(1))
  const { webview } = findBrowser(browserName)
  await waitForReady(webview)
  const params = rest.slice(1)

  switch (sub) {
    case 'snapshot':
      return (await webview.executeJavaScript(SNAPSHOT_SCRIPT)) as string
    case 'navigate':
      await webview.loadURL(params[0])
      return `Navigated to ${params[0]}`
    case 'info':
      return `url: ${webview.getURL()}\ntitle: ${webview.getTitle()}\nviewport: ${await webview.executeJavaScript('innerWidth + "x" + innerHeight')}`
    case 'click':
      return withElement(webview, params[0], `el.click(); return 'Clicked'`)
    case 'fill':
      return withElement(
        webview,
        params[0],
        `el.focus(); el.value = ${JSON.stringify(params[1] ?? '')};
         el.dispatchEvent(new Event('input', { bubbles: true }));
         el.dispatchEvent(new Event('change', { bubbles: true }));
         return 'Filled'`
      )
    case 'type':
      return withElement(
        webview,
        params.length > 1 ? params[0] : ':focus',
        `el.focus(); el.value = (el.value || '') + ${JSON.stringify(params[params.length - 1] ?? '')};
         el.dispatchEvent(new Event('input', { bubbles: true }));
         return 'Typed'`
      )
    case 'key':
      return webview.executeJavaScript(
        `(() => {
          const key = ${JSON.stringify(params[0] ?? 'Enter')}
          const el = document.activeElement || document.body
          for (const type of ['keydown', 'keypress', 'keyup']) {
            el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }))
          }
          if (key === 'Enter' && el.form) el.form.requestSubmit()
          return 'Pressed ' + key
        })()`
      ) as Promise<string>
    case 'text':
      return withElement(webview, params[0] ?? 'body', `return el.innerText.slice(0, 20000)`)
    case 'html':
      return (await webview.executeJavaScript(
        'document.documentElement.outerHTML.slice(0, 100000)'
      )) as string
    case 'evaluate':
      return String(await webview.executeJavaScript(params[0] ?? ''))
    case 'scroll': {
      const dir = params[0] ?? 'down'
      const amount = parseInt(params[1] ?? '300', 10)
      const [dx, dy] =
        dir === 'down' ? [0, amount] : dir === 'up' ? [0, -amount] : dir === 'right' ? [amount, 0] : [-amount, 0]
      await webview.executeJavaScript(`scrollBy(${dx}, ${dy})`)
      return `Scrolled ${dir} ${amount}`
    }
    default:
      throw new Error(`Unknown browser command '${sub}'`)
  }
}

/** Hook: listens for browser commands forwarded from the main process. */
export function useBrowserEngine(): void {
  useEffect(() => {
    console.log('[cookrew] browser engine listening')
    return cookrew().onBrowserCommand((request) => {
      console.log('[cookrew] browser command', request.args.join(' '))
      runBrowserCommand(request.args, request.terminalId)
        .then((output) => cookrew().browserResult(request.id, true, output))
        .catch((error: Error) => cookrew().browserResult(request.id, false, error.message))
    })
  }, [])
}
