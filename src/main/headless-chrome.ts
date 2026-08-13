// Node-owned headless Chromium runtime for interactive browser nodes.
//
// One process owns one persistent profile and one CDP page target per Cookrew
// tab. Agent automation and every streamed viewer operate on the same active
// target. The class is deliberately network-agnostic: untrusted WS messages are
// sanitized by browser-cast before they reach dispatchInput.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import type { BrowserTab } from '../shared/model'
import type { CdpInputCommand } from '../shared/cast-input'
import type { ViewportMetrics } from '../shared/cast-viewport'
import {
  BrowserViewportCoordinator,
  type BrowserViewportState
} from './browser-viewport'
import { CdpClient } from './cdp-client'

function httpJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as T)
        } catch (error) {
          reject(error as Error)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('timeout')))
  })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const POLL_INTERVAL_MS = 66
const NAVIGATION_TIMEOUT_MS = 15_000
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 4_000
const FORCED_SHUTDOWN_TIMEOUT_MS = 1_000
export const STATIC_FRAME_HEARTBEAT_MS = 750

/** Keep static pages live without resending an identical JPEG every poll tick. */
export function shouldEmitFrame(
  hash: string,
  lastHash: string,
  now: number,
  lastFrameAt: number,
  heartbeatMs = STATIC_FRAME_HEARTBEAT_MS
): boolean {
  return hash !== lastHash || lastFrameAt === 0 || now - lastFrameAt >= heartbeatMs
}

export function findChrome(): string | null {
  const override = process.env.COOKREW_CHROME_PATH
  if (override && existsSync(override)) return override
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

const THROTTLE_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling'
]

export interface HeadlessOptions {
  executablePath: string
  profileDir: string
  width: number
  height: number
  tabs: BrowserTab[]
  activeTabId: string
  quality?: number
  /** Integration-test hook: hold startup after spawn so cancellation is deterministic. */
  startupDelayMs?: number
}

export interface FrameMeta {
  deviceWidth?: number
  deviceHeight?: number
  /** Visual viewport zoom reported by Page.screencastFrame metadata. */
  pageScaleFactor?: number
  mobile?: boolean
  revision?: number
}

export interface HeadlessPageState {
  url: string
  title: string
}

export interface HeadlessStopResult {
  pid: number | null
  forced: boolean
}

interface TargetInfo {
  id: string
  type?: string
  url?: string
  webSocketDebuggerUrl?: string
}

interface PageBinding extends HeadlessPageState {
  tabId: string
  targetId: string
  cdp: CdpClient
  closing: boolean
  screencasting: boolean
}

interface RuntimeRemoteObject {
  value?: unknown
  description?: string
}

interface RuntimeEvaluateResult {
  result?: RuntimeRemoteObject
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

/** One browser node: one Chromium process/profile, with one target per tab. */
export class HeadlessInstance {
  private proc: ChildProcess | null = null
  private browserCdp: CdpClient | null = null
  private port = 0
  private closed = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastFrameAt = 0
  private lastHash = ''
  private width: number
  private height: number
  private mobile = false
  private activeTabId: string
  private stopPromise: Promise<HeadlessStopResult> | null = null
  private readonly viewportCoordinator: BrowserViewportCoordinator
  private readonly pages = new Map<string, PageBinding>()
  private readonly targetToTab = new Map<string, string>()
  private programmaticTargetCreates = 0
  private readonly programmaticTargetIds = new Set<string>()
  private readonly deferredTargetCreates = new Map<string, Record<string, unknown>>()
  private syncTail: Promise<void> = Promise.resolve()

  readonly frameListeners = new Set<(jpegBase64: string, meta: FrameMeta) => void>()
  onExit: () => void = () => undefined
  onPageState: (tabId: string, state: HeadlessPageState) => void = () => undefined
  onTabOpened: (tab: BrowserTab) => void = () => undefined
  onTabClosed: (tabId: string) => void = () => undefined

  constructor(private readonly opts: HeadlessOptions) {
    this.width = opts.width
    this.height = opts.height
    this.activeTabId = opts.activeTabId
    this.viewportCoordinator = new BrowserViewportCoordinator(
      { width: opts.width, height: opts.height, mobile: false },
      (metrics) => this.applyViewportMetrics(metrics)
    )
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('headless browser is closed')
    const tabs = this.opts.tabs.length > 0 ? this.opts.tabs : [fallbackTab()]
    const active = tabs.find((tab) => tab.id === this.opts.activeTabId) ?? tabs[0]
    this.activeTabId = active.id

    mkdirSync(this.opts.profileDir, { recursive: true })
    for (const file of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) {
      try {
        rmSync(path.join(this.opts.profileDir, file), { force: true })
      } catch {
        // Best effort. Profile data itself is never removed.
      }
    }

    const args = [
      '--headless=new',
      `--user-data-dir=${this.opts.profileDir}`,
      '--remote-debugging-port=0',
      `--window-size=${this.width},${this.height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      ...THROTTLE_FLAGS,
      active.url
    ]
    this.proc = spawn(this.opts.executablePath, args, { stdio: 'ignore' })
    this.proc.on('exit', () => {
      if (!this.closed) this.onExit()
    })

    if (this.opts.startupDelayMs && this.opts.startupDelayMs > 0) {
      await sleep(this.opts.startupDelayMs)
      if (this.closed) throw new Error('instance closed during startup')
    }

    this.port = await this.readDevToolsPort()
    const browserWs = await this.browserWebSocket()
    const browserCdp = new CdpClient()
    browserCdp.onClose = () => {
      if (!this.closed) this.onExit()
    }
    await browserCdp.connect(browserWs)
    if (this.closed) {
      browserCdp.close()
      throw new Error('instance closed during startup')
    }
    this.browserCdp = browserCdp

    const initialTarget = await this.firstPageTarget()
    await this.connectPage(active, initialTarget)
    for (const tab of tabs) {
      if (tab.id !== active.id) await this.createPage(tab)
    }
    await this.activatePage(active.id)
    browserCdp.on('Target.targetCreated', (params) => void this.onTargetCreated(params))
    browserCdp.on('Target.targetInfoChanged', (params) => this.onTargetInfoChanged(params))
    await browserCdp.send('Target.setDiscoverTargets', { discover: true })
    this.pollTimer = setInterval(() => void this.pollTick(), POLL_INTERVAL_MS)
  }

  private async readDevToolsPort(): Promise<number> {
    const file = path.join(this.opts.profileDir, 'DevToolsActivePort')
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (this.closed) throw new Error('instance closed during startup')
      if (existsSync(file)) {
        const port = Number(readFileSync(file, 'utf8').split('\n')[0]?.trim())
        if (Number.isFinite(port) && port > 0) return port
      }
      await sleep(100)
    }
    throw new Error('Chrome DevTools port never appeared')
  }

  private async browserWebSocket(): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.closed) throw new Error('instance closed during startup')
      try {
        const version = await httpJson<{ webSocketDebuggerUrl?: string }>(
          `http://127.0.0.1:${this.port}/json/version`
        )
        if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl
      } catch {
        // Chrome is still starting.
      }
      await sleep(100)
    }
    throw new Error('Chrome browser target never appeared')
  }

  private async targets(): Promise<TargetInfo[]> {
    return httpJson<TargetInfo[]>(`http://127.0.0.1:${this.port}/json`)
  }

  private async firstPageTarget(): Promise<TargetInfo> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.closed) throw new Error('instance closed during startup')
      try {
        const target = (await this.targets()).find(
          (candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl
        )
        if (target?.webSocketDebuggerUrl) return target
      } catch {
        // Chrome is still publishing targets.
      }
      await sleep(100)
    }
    throw new Error('no page target found')
  }

  private async targetById(targetId: string): Promise<TargetInfo> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.closed) throw new Error('instance closed while creating tab')
      const target = (await this.targets()).find(
        (candidate) => candidate.id === targetId && candidate.webSocketDebuggerUrl
      )
      if (target?.webSocketDebuggerUrl) return target
      await sleep(50)
    }
    throw new Error(`page target ${targetId} never appeared`)
  }

  private async connectPage(tab: BrowserTab, target: TargetInfo): Promise<PageBinding> {
    if (!target.webSocketDebuggerUrl) throw new Error('page target has no debugger URL')
    const cdp = new CdpClient()
    const page: PageBinding = {
      tabId: tab.id,
      targetId: target.id,
      cdp,
      url: target.url || tab.url,
      title: tab.title,
      closing: false,
      screencasting: false
    }
    cdp.onClose = () => {
      if (this.closed || page.closing) return
      this.pages.delete(page.tabId)
      this.onTabClosed(page.tabId)
      if (page.tabId === this.activeTabId && this.pages.size === 0) this.onExit()
    }
    await cdp.connect(target.webSocketDebuggerUrl)
    if (this.closed) {
      cdp.close()
      throw new Error('instance closed while attaching page target')
    }
    this.pages.set(tab.id, page)
    this.targetToTab.set(target.id, tab.id)

    cdp.on('Page.screencastFrame', (params) => this.onScreencastFrame(page, params))
    cdp.on('Page.frameNavigated', (params) => {
      const frame = params.frame as { parentId?: string } | undefined
      if (!frame?.parentId) void this.refreshPageState(page)
    })
    cdp.on('Page.navigatedWithinDocument', () => void this.refreshPageState(page))
    cdp.on('Page.loadEventFired', () => void this.refreshPageState(page))

    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await this.resizePage(page)
    await this.refreshPageState(page)
    return page
  }

  private async createPage(tab: BrowserTab): Promise<PageBinding> {
    this.programmaticTargetCreates += 1
    let targetId: string | null = null
    try {
      const result = (await this.browserCdp?.send('Target.createTarget', { url: tab.url })) as
        | { targetId?: string }
        | undefined
      if (!result?.targetId) throw new Error('Chrome did not create a page target')
      targetId = result.targetId
      this.programmaticTargetIds.add(targetId)
      return await this.connectPage(tab, await this.targetById(targetId))
    } finally {
      if (targetId) {
        this.programmaticTargetIds.delete(targetId)
        this.deferredTargetCreates.delete(targetId)
      }
      this.programmaticTargetCreates -= 1
      if (this.programmaticTargetCreates === 0) this.drainDeferredTargetCreates()
    }
  }

  private async onTargetCreated(params: Record<string, unknown>): Promise<void> {
    if (this.closed) return
    const info = params.targetInfo as
      | { targetId?: string; type?: string; url?: string }
      | undefined
    if (
      !info?.targetId ||
      info.type !== 'page' ||
      this.targetToTab.has(info.targetId)
    ) {
      return
    }
    if (this.programmaticTargetIds.has(info.targetId)) return
    if (this.programmaticTargetCreates > 0) {
      this.deferredTargetCreates.set(info.targetId, params)
      return
    }
    try {
      const tab: BrowserTab = {
        id: randomUUID(),
        url: info.url || 'about:blank',
        title: ''
      }
      const page = await this.connectPage(tab, await this.targetById(info.targetId))
      await this.refreshPageState(page)
      this.onTabOpened({ id: tab.id, url: page.url, title: page.title })
    } catch {
      // A popup may close before its debugger endpoint is attachable.
    }
  }

  private drainDeferredTargetCreates(): void {
    const deferred = [...this.deferredTargetCreates.values()]
    this.deferredTargetCreates.clear()
    for (const params of deferred) void this.onTargetCreated(params)
  }

  private onTargetInfoChanged(params: Record<string, unknown>): void {
    const info = params.targetInfo as
      | { targetId?: string; url?: string; title?: string }
      | undefined
    if (!info?.targetId) return
    const tabId = this.targetToTab.get(info.targetId)
    const page = tabId ? this.pages.get(tabId) : undefined
    if (!page) return
    const url = info.url || page.url
    const title = typeof info.title === 'string' ? info.title : page.title
    if (url === page.url && title === page.title) return
    page.url = url
    page.title = title
    this.onPageState(page.tabId, { url, title })
  }

  /** Reconcile the process's real page targets with the browser-node tab model. */
  syncTabs(tabs: BrowserTab[], activeTabId: string): Promise<void> {
    const desired = tabs.length > 0 ? tabs : [fallbackTab()]
    const run = this.syncTail.then(() => this.applyTabs(desired, activeTabId))
    this.syncTail = run.catch(() => undefined)
    return run
  }

  private async applyTabs(tabs: BrowserTab[], requestedActiveId: string): Promise<void> {
    if (this.closed) throw new Error('headless browser is closed')
    const desired = new Map(tabs.map((tab) => [tab.id, tab]))

    for (const page of [...this.pages.values()]) {
      if (desired.has(page.tabId)) continue
      await this.closePage(page)
    }

    for (const tab of tabs) {
      const page = this.pages.get(tab.id)
      if (!page) {
        await this.createPage(tab)
      } else if (tab.url && tab.url !== page.url) {
        await this.navigatePage(page, tab.url, false)
      }
    }

    const activeId = desired.has(requestedActiveId) ? requestedActiveId : tabs[0].id
    await this.activatePage(activeId)
  }

  private async closePage(page: PageBinding): Promise<void> {
    page.closing = true
    this.pages.delete(page.tabId)
    this.targetToTab.delete(page.targetId)
    if (page.screencasting) {
      await page.cdp.send('Page.stopScreencast').catch(() => undefined)
      page.screencasting = false
    }
    page.cdp.close()
    await this.browserCdp?.send('Target.closeTarget', { targetId: page.targetId }).catch(() => undefined)
  }

  private async activatePage(tabId: string): Promise<void> {
    const next = this.pages.get(tabId)
    if (!next) throw new Error(`headless tab '${tabId}' is unavailable`)
    const previous = this.pages.get(this.activeTabId)
    if (previous && previous !== next && previous.screencasting) {
      await previous.cdp.send('Page.stopScreencast').catch(() => undefined)
      previous.screencasting = false
    }
    this.activeTabId = tabId
    this.lastHash = ''
    await this.browserCdp?.send('Target.activateTarget', { targetId: next.targetId })
    if (!next.screencasting) {
      await next.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.opts.quality ?? 60,
        maxWidth: this.width,
        maxHeight: this.height,
        everyNthFrame: 1
      })
      next.screencasting = true
    }
    await this.refreshPageState(next)
  }

  private onScreencastFrame(page: PageBinding, params: Record<string, unknown>): void {
    const sessionId = params.sessionId as number
    void page.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined)
    if (page.tabId !== this.activeTabId || this.viewportCoordinator.state.transitioning) return
    const data = params.data
    if (typeof data === 'string' && data.length > 0) {
      this.emitFrame(data, (params.metadata ?? {}) as FrameMeta)
    }
  }

  /**
   * A single still of the active tab, for the canvas card's thumbnail.
   *
   * Separate from the screencast on purpose: the stream only runs while
   * something is watching (frameListeners), so with the flag on a card that has
   * never been zoomed had no picture at all and fell back to the placeholder.
   * This asks the page directly and is safe to call when nobody is streaming.
   *
   * Skipped mid-transition for the same reason pollTick skips: a capture taken
   * while the viewport is being resized shows the wrong geometry.
   */
  async snapshot(): Promise<string | null> {
    if (this.closed || this.viewportCoordinator.state.transitioning) return null
    const page = this.pages.get(this.activeTabId)
    if (!page) return null
    const shot = (await page.cdp
      .send('Page.captureScreenshot', { format: 'jpeg', quality: 55 })
      .catch(() => null)) as { data?: string } | null
    return typeof shot?.data === 'string' && shot.data.length > 0 ? shot.data : null
  }

  private async pollTick(): Promise<void> {
    if (
      this.closed ||
      this.frameListeners.size === 0 ||
      this.viewportCoordinator.state.transitioning
    ) return
    if (Date.now() - this.lastFrameAt < POLL_INTERVAL_MS) return
    const page = this.pages.get(this.activeTabId)
    if (!page) return
    try {
      const [shot, layout] = await Promise.all([
        page.cdp.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: this.opts.quality ?? 60
        }).catch(() => null) as Promise<{ data?: string } | null>,
        page.cdp.send('Page.getLayoutMetrics').catch(() => null) as Promise<{
          visualViewport?: { scale?: unknown }
        } | null>
      ])
      const scale = layout?.visualViewport?.scale
      if (shot?.data && typeof scale === 'number' && Number.isFinite(scale) && scale > 0) {
        this.emitFrame(shot.data, {
          pageScaleFactor: scale
        })
      }
    } catch {
      // Navigation can temporarily reject captures; the next tick retries.
    }
  }

  private emitFrame(base64: string, meta: FrameMeta): void {
    const viewport = this.viewportCoordinator.state
    if (this.closed || viewport.transitioning) return
    const hash = createHash('md5').update(base64).digest('base64')
    const now = Date.now()
    if (!shouldEmitFrame(hash, this.lastHash, now, this.lastFrameAt)) return
    this.lastHash = hash
    this.lastFrameAt = now
    const effectiveMeta: FrameMeta = {
      ...meta,
      deviceWidth: viewport.width,
      deviceHeight: viewport.height,
      mobile: viewport.mobile,
      revision: viewport.revision
    }
    for (const listener of this.frameListeners) listener(base64, effectiveMeta)
  }

  private async refreshPageState(page: PageBinding): Promise<HeadlessPageState> {
    try {
      const value = await this.evaluateOn(
        page,
        '({ url: location.href, title: document.title })'
      )
      if (typeof value === 'object' && value !== null) {
        const state = value as { url?: unknown; title?: unknown }
        const url = typeof state.url === 'string' ? state.url : page.url
        const title = typeof state.title === 'string' ? state.title : page.title
        if (url !== page.url || title !== page.title) {
          page.url = url
          page.title = title
          this.onPageState(page.tabId, { url, title })
        }
      }
    } catch {
      // The execution context disappears during navigation; load will retry.
    }
    return { url: page.url, title: page.title }
  }

  private async evaluateOn(page: PageBinding, expression: string): Promise<unknown> {
    const response = (await page.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })) as RuntimeEvaluateResult
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          'browser evaluation failed'
      )
    }
    if (response.result && Object.prototype.hasOwnProperty.call(response.result, 'value')) {
      return response.result.value
    }
    return response.result?.description
  }

  evaluate(expression: string): Promise<unknown> {
    const page = this.pages.get(this.activeTabId)
    if (!page) return Promise.reject(new Error('active browser tab is unavailable'))
    return this.evaluateOn(page, expression)
  }

  async navigate(url: string): Promise<void> {
    const page = this.pages.get(this.activeTabId)
    if (!page) throw new Error('active browser tab is unavailable')
    await this.navigatePage(page, url, true)
  }

  private async navigatePage(page: PageBinding, url: string, waitForLoad: boolean): Promise<void> {
    let onLoad = (): void => undefined
    const loaded = new Promise<void>((resolve) => {
      onLoad = resolve
      page.cdp.on('Page.loadEventFired', onLoad)
    })
    const result = (await page.cdp.send('Page.navigate', { url })) as { errorText?: string }
    if (result.errorText) {
      page.cdp.off('Page.loadEventFired', onLoad)
      throw new Error(result.errorText)
    }
    page.url = url
    this.onPageState(page.tabId, { url, title: page.title })
    if (waitForLoad) {
      await Promise.race([loaded, sleep(NAVIGATION_TIMEOUT_MS)])
    }
    page.cdp.off('Page.loadEventFired', onLoad)
    await this.refreshPageState(page)
  }

  async pageInfo(): Promise<HeadlessPageState & { viewport: string }> {
    const page = this.pages.get(this.activeTabId)
    if (!page) throw new Error('active browser tab is unavailable')
    const state = await this.refreshPageState(page)
    const viewport = this.viewportCoordinator.state
    return { ...state, viewport: `${viewport.width}x${viewport.height}` }
  }

  /** Update the node-card fallback without clobbering a viewer-owned viewport. */
  async resize(width: number, height: number): Promise<void> {
    this.viewportCoordinator.setDefault({ width, height, mobile: false })
  }

  private async applyViewportMetrics(metrics: ViewportMetrics): Promise<void> {
    if (this.closed) throw new Error('headless browser is closed')
    const active = this.pages.get(this.activeTabId)
    if (active?.screencasting) {
      await active.cdp.send('Page.stopScreencast').catch(() => undefined)
      active.screencasting = false
    }
    this.width = metrics.width
    this.height = metrics.height
    this.mobile = metrics.mobile
    this.lastHash = ''
    for (const page of this.pages.values()) await this.resizePage(page, metrics)
    if (active) await this.activatePage(active.tabId)
  }

  private async resizePage(
    page: PageBinding,
    metrics: ViewportMetrics = { width: this.width, height: this.height, mobile: this.mobile }
  ): Promise<void> {
    await page.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: metrics.width,
      height: metrics.height,
      deviceScaleFactor: 1,
      mobile: metrics.mobile,
      screenWidth: metrics.width,
      screenHeight: metrics.height
    })
    await page.cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: metrics.mobile,
      ...(metrics.mobile ? { maxTouchPoints: 2 } : {})
    })
  }

  registerViewportViewer(id: string): void {
    this.viewportCoordinator.registerViewer(id)
  }

  offerViewport(id: string, metrics: ViewportMetrics): void {
    this.viewportCoordinator.offer(id, metrics)
  }

  claimViewport(id: string, metrics: ViewportMetrics): boolean {
    return this.viewportCoordinator.claim(id, metrics)
  }

  releaseViewport(id: string): void {
    this.viewportCoordinator.release(id)
  }

  unregisterViewportViewer(id: string): void {
    this.viewportCoordinator.unregisterViewer(id)
  }

  onViewportState(listener: (state: BrowserViewportState) => void): () => void {
    return this.viewportCoordinator.onState(listener)
  }

  beginAgentViewportActivity(): Promise<() => void> {
    return this.viewportCoordinator.beginAgentActivity()
  }

  dispatchInput(method: CdpInputCommand['method'], params: CdpInputCommand['params']): void {
    const page = this.pages.get(this.activeTabId)
    void page?.cdp.send(method, params).catch(() => undefined)
  }

  get viewport(): { width: number; height: number } {
    const { width, height } = this.viewportCoordinator.state
    return { width, height }
  }

  get viewportState(): BrowserViewportState {
    return this.viewportCoordinator.state
  }

  get devToolsPort(): number {
    return this.port
  }

  get processId(): number | null {
    return this.proc?.pid ?? null
  }

  stop(gracefulTimeoutMs = GRACEFUL_SHUTDOWN_TIMEOUT_MS): Promise<HeadlessStopResult> {
    if (this.stopPromise) return this.stopPromise
    this.closed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.frameListeners.clear()
    this.viewportCoordinator.dispose()
    for (const page of this.pages.values()) {
      page.closing = true
      page.cdp.close()
    }
    this.pages.clear()
    this.targetToTab.clear()
    this.programmaticTargetIds.clear()
    this.deferredTargetCreates.clear()
    this.browserCdp?.close()
    this.browserCdp = null

    const proc = this.proc
    const pid = proc?.pid ?? null
    this.stopPromise = this.terminateProcess(proc, pid, gracefulTimeoutMs)
    return this.stopPromise
  }

  private async terminateProcess(
    proc: ChildProcess | null,
    pid: number | null,
    gracefulTimeoutMs: number
  ): Promise<HeadlessStopResult> {
    if (!proc || processExited(proc)) return { pid, forced: false }
    try {
      proc.kill('SIGTERM')
    } catch {
      // The bounded wait below distinguishes a raced exit from a live child.
    }

    const exitedGracefully =
      gracefulTimeoutMs > 0
        ? await waitForProcessExit(proc, gracefulTimeoutMs)
        : processExited(proc)
    if (exitedGracefully) return { pid, forced: false }

    try {
      proc.kill('SIGKILL')
    } catch {
      // It exited between the timeout and fallback signal.
    }
    if (!(await waitForProcessExit(proc, FORCED_SHUTDOWN_TIMEOUT_MS))) {
      throw new Error(`Chromium process ${pid ?? '(unknown)'} did not exit after SIGKILL`)
    }
    return { pid, forced: true }
  }
}

function processExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (processExited(proc)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    const timer = setTimeout(() => finish(processExited(proc)), Math.max(0, timeoutMs))
    proc.once('exit', onExit)
    if (processExited(proc)) finish(true)
  })
}

function fallbackTab(): BrowserTab {
  return { id: 'main', url: 'about:blank', title: '' }
}
