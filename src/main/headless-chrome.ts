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
import { shareInstallationDirs } from './browser-scope'
import { DownloadWatcher, type ArrivingDownload } from './browser-downloads'
import type { BrowserTab } from '../shared/model'
import { observedBrowserUrl } from '../shared/browser-navigation'
import type { CdpInputCommand } from '../shared/cast-input'
import { VIEWPORT_SCALE_MAX, type ViewportMetrics } from '../shared/cast-viewport'
import { castTuning } from './cast-tuning'
import {
  BrowserViewportCoordinator,
  type BrowserViewportState
} from './browser-viewport'
import { CdpClient } from './cdp-client'
import {
  applySignInCompatibility,
  cdpIdentityProbe,
  presentableUserAgent,
  readNativeIdentity,
  type NativeIdentity
} from './browser-signin'
import { COPY_BINDING, PAGE_COPY_SCRIPT, PASTE_FUNCTION, copyText } from './page-copy'
import { FIELDS_BINDING, FIELDS_WATCH, PAGE_FIELDS_SCRIPT, sanitizeFieldReport, type FieldReport } from './page-fields'
import { restoreCardCookies } from './card-cookie-restore'
import type { CookiePartitionKey, VaultCookie } from './card-cookie-shape'

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

/** A browser build does not change what it is, so each is asked once. */
const identityByBuild = new Map<string, NativeIdentity>()

const POLL_INTERVAL_MS = 66
/** A screencast silent this long is started again (pollTick). */
const SCREENCAST_STALL_MS = 3000
/** How long a Chrome asked to close (CDP Browser.close) has to write its profile and go. */
const CLOSE_ASK_TIMEOUT_MS = 8_000
/** A viewer's raised screencast quality stays this long after it lets go (preferSourceQuality). */
const QUALITY_RELEASE_MS = 10_000
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

/**
 * What a target Chrome opened by itself is. `browser-ui` is a piece of Chrome's
 * own window (a *.top-chrome bubble such as the sign-in intercept), left alone;
 * `page` is any other chrome:// page, which no site can open; `site` is the
 * rest. Pages the card itself asks for never reach this question.
 */
export function internalPageKind(url: string): 'site' | 'page' | 'browser-ui' {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'site'
  }
  if (parsed.protocol !== 'chrome:' && parsed.protocol !== 'chrome-untrusted:') return 'site'
  return parsed.hostname.endsWith('.top-chrome') ? 'browser-ui' : 'page'
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

const DISABLED_BACKGROUND_FEATURES = [
  'Translate',
  'OptimizationHints',
  'OptimizationGuideModelDownloading',
  'OptimizationTargetPrediction',
  'OnDeviceModel',
  'OnDeviceModelService'
]

/** One profile must never download browser components or multi-GB local models. */
export function headlessLaunchArgs(
  profileDir: string,
  width: number,
  height: number,
  url: string,
): string[] {
  return [
    '--headless=new',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    `--disable-features=${DISABLED_BACKGROUND_FEATURES.join(',')}`,
    // Owner ruling 2026-11-08: --remote-debugging-port alone sets
    // navigator.webdriver=true (measured on Chrome 157, headed or headless), and
    // Google now refuses sign-in right after the email step because of it. A
    // person drives this card, so the owner chose to drop that one marker.
    // Nothing else is disguised. See browser-signin.ts.
    '--disable-blink-features=AutomationControlled',
    // A card signs in to Google SITES, never to Chrome itself. With browser
    // sign-in allowed, a web sign-in made Chrome adopt the account and raise a
    // "sign in to Chrome" bubble nobody can see (2026-11-09). Measured: Google
    // still takes the email step with this off. (The chrome://settings/help
    // pop-up of the same day was the key codes, see cast-input.ts.)
    '--allow-browser-signin=false',
    // A PHONE'S PICTURE AT ITS OWN SHARPNESS (measured on Chrome 158, 11-24).
    // Headless screencast frames ignore the emulated deviceScaleFactor: a 3x
    // viewport still streamed 390x844, so an iPhone stretched every frame 3x.
    // With the process scale forced to the most any viewer may ask, frames
    // follow each viewport's own scale — 1x stays 390x844, 2x is 780x1688 —
    // and screencast and still frames agree (no 1x/2x alternation, 11-03).
    `--force-device-scale-factor=${CAST_SCALE_CEILING}`,
    ...THROTTLE_FLAGS,
    url
  ]
}

/** The scale every card Chrome is launched able to stream (headlessLaunchArgs). */
export const CAST_SCALE_CEILING = VIEWPORT_SCALE_MAX

/**
 * What to run so Chrome starts. With a launcher (resources/cr-disclaim) Chrome
 * becomes its own responsible app on macOS: started straight from Cookrew, its
 * launch-time write into its own bundle is refused by App Management and macOS
 * tells the person Cookrew "was prevented from modifying apps". The launcher
 * execs Chrome in place, so the pid stop() signals is still Chrome's.
 */
export function chromeSpawnCommand(
  executablePath: string,
  args: readonly string[],
  launcher: string | undefined
): { command: string; args: string[] } {
  return launcher
    ? { command: launcher, args: [executablePath, ...args] }
    : { command: executablePath, args: [...args] }
}

export interface HeadlessOptions {
  executablePath: string
  /** Runs Chrome as its own responsible app (chromeSpawnCommand). Absent: spawned directly. */
  launcher?: string
  profileDir: string
  /**
   * One store for the installation-scope directories every profile would
   * otherwise download for itself. Absent means each profile keeps its own.
   */
  sharedInstallationDir?: string
  /** Where this card's files land (browser-downloads.ts). Absent: Chrome's default, ~/Downloads. */
  downloadDir?: string
  width: number
  height: number
  tabs: BrowserTab[]
  activeTabId: string
  quality?: number
  /** Integration-test hook: hold startup after spawn so cancellation is deterministic. */
  startupDelayMs?: number
  /** Set before the first page loads (CDP Storage.setCookies): a card signed in to a page main opened for it (magpie-card-open.ts). */
  cookies?: readonly HeadlessCookie[]
  /**
   * The card's kept cookies (card-cookie-vault.ts), set before the first page
   * loads where Chrome has none of its own and `cookies` does not name them
   * (card-cookie-restore.ts). A refusal never fails the start.
   */
  restoredCookies?: readonly VaultCookie[]
}

/** A cookie as CDP's Storage.setCookies takes it (Network.CookieParam): a url, a domain, or both. */
export interface HeadlessCookie {
  readonly name: string
  readonly value: string
  readonly url?: string
  readonly domain?: string
  readonly path?: string
  /** Seconds since the epoch; absent: a session cookie. */
  readonly expires?: number
  readonly httpOnly?: boolean
  readonly secure?: boolean
  readonly sameSite?: 'Lax' | 'Strict' | 'None'
  readonly partitionKey?: CookiePartitionKey
}

export interface FrameMeta {
  deviceWidth?: number
  deviceHeight?: number
  /** Visual viewport zoom reported by Page.screencastFrame metadata. */
  pageScaleFactor?: number
  /** How far the page is scrolled, in CSS pixels: Page.screencastFrame's own name for it. */
  scrollOffsetY?: number
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
  /** The quality and size the running screencast was started with (ensureScreencast). */
  castKey?: string
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
  /**
   * The UA every page presents, read from the running browser and stripped of
   * its automation tell. Empty until startup has read /json/version.
   */
  private userAgent = ''
  /** Keys identityByBuild. Empty until startup has read /json/version. */
  private browserBuild = ''
  /** Chrome's own client hints, handed back with the UA. See browser-signin.ts. */
  private identity: NativeIdentity | null = null
  private port = 0
  private closed = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastFrameAt = 0
  private lastHash = ''
  /** When the screencast last sent a picture: a stall is when it has not for SCREENCAST_STALL_MS (pollTick). */
  private lastScreencastAt = 0
  /** The last picture sent, said again as a still page's heartbeat while the screencast lives (pollTick). */
  private lastEmitted: { base64: string; meta: FrameMeta; revision: number } | null = null
  private width: number
  private height: number
  private mobile = false
  /** Device pixels per CSS px the viewport owner asked for (cast-viewport.ts · viewportScale). */
  private scale = 1
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
  /** The most device scale this Chrome streams at: it is launched forced to it (headlessLaunchArgs). */
  readonly scaleCeiling = CAST_SCALE_CEILING
  /** The JPEG quality the running screencast was started with; 0 before the first. */
  private streamQuality = 0

  get frameQualityInUse(): number {
    return this.streamQuality
  }

  /** What each viewer asked the screencast's quality to be at least (an H.264 viewer's encoder input). */
  private readonly qualityAsks = new Map<string, number>()

  /**
   * A frame's JPEG quality: this card's own if it was given one, else the
   * tuning's (cast-tuning.ts), raised to the highest any viewer asked for.
   */
  private frameQuality(): number {
    const base = this.opts.quality ?? castTuning().quality
    return Math.max(base, ...this.qualityAsks.values())
  }

  /** A viewer's ask, let go of only after QUALITY_RELEASE_MS: one that comes back meanwhile changes nothing. */
  private readonly qualityReleases = new Map<string, ReturnType<typeof setTimeout>>()

  preferSourceQuality(viewerId: string, quality: number | null): void {
    const releasing = this.qualityReleases.get(viewerId)
    if (releasing) clearTimeout(releasing)
    this.qualityReleases.delete(viewerId)
    if (quality === null) {
      if (!this.qualityAsks.has(viewerId)) return
      // Every viewer gets the screencast's quality, and a change of it restarts the
      // stream for all of them: a phone dropping off and back on must not flap it.
      const timer = setTimeout(() => {
        this.qualityReleases.delete(viewerId)
        this.qualityAsks.delete(viewerId)
        this.requalify()
      }, QUALITY_RELEASE_MS)
      timer.unref?.()
      this.qualityReleases.set(viewerId, timer)
      return
    }
    this.qualityAsks.set(viewerId, Math.min(95, Math.max(30, Math.round(quality))))
    this.requalify()
  }

  /** The screencast takes its quality when it starts: started again if that changed. */
  private requalify(): void {
    const active = this.pages.get(this.activeTabId)
    if (this.closed || !active?.screencasting) return
    void this.ensureScreencast(active).catch((error: unknown) => console.error('Restarting a card screencast failed:', error))
  }
  /** Text the active page copied (page-copy.ts); the cast decides which viewer gets it. */
  readonly copyListeners = new Set<(text: string) => void>()
  /** Viewers watching where the page's text fields are (page-fields.ts); the page reports only while this is non-empty. */
  private readonly fieldListeners = new Set<(report: FieldReport) => void>()
  private lastFields: FieldReport | null = null
  onExit: () => void = () => undefined
  onPageState: (tabId: string, state: HeadlessPageState) => void = () => undefined
  onTabOpened: (tab: BrowserTab) => void = () => undefined
  onTabClosed: (tabId: string) => void = () => undefined

  private readonly downloads: DownloadWatcher | null

  constructor(private readonly opts: HeadlessOptions) {
    this.downloads = opts.downloadDir ? new DownloadWatcher(opts.downloadDir) : null
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
    // Installation-scope state belongs to the installation. Done HERE because
    // this is the one moment the profile is provably unattached — the same
    // reason the singleton files are cleared on the line above — and Chrome
    // holds these directories open while it runs.
    if (this.opts.sharedInstallationDir) {
      const freed = shareInstallationDirs(this.opts.profileDir, this.opts.sharedInstallationDir)
      if (freed > 0) {
        console.error(
          `browser scope: shared ${(freed / 1024 ** 2).toFixed(0)}MB of components for this profile`
        )
      }
    }

    const launch = chromeSpawnCommand(
      this.opts.executablePath,
      headlessLaunchArgs(this.opts.profileDir, this.width, this.height, active.url),
      this.opts.launcher
    )
    this.proc = spawn(launch.command, launch.args, { stdio: 'ignore' })
    // A spawn that cannot even start (a launcher of the wrong architecture)
    // emits 'error', which would throw in main with no listener.
    this.proc.on('error', (error) => {
      console.error(`Browser card could not start ${launch.command}:`, error)
    })
    this.proc.on('exit', (code, signal) => {
      // 127 is cr-disclaim's own "could not start Chrome".
      if (code !== 0 && code !== null) console.error(`Browser card Chrome exited with code ${code}`)
      else if (signal && !this.closed) console.error(`Browser card Chrome died of ${signal}`)
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
    await this.downloads?.attach(browserCdp)
    // Before any page loads: the first request already carries them. Kept
    // cookies first, then primed ones over them.
    if (this.opts.restoredCookies && this.opts.restoredCookies.length > 0) {
      await restoreCardCookies((method, params) => browserCdp.send(method, params), this.opts.restoredCookies, this.opts.cookies ?? [])
    }
    if (this.opts.cookies && this.opts.cookies.length > 0) await browserCdp.send('Storage.setCookies', { cookies: this.opts.cookies })

    // In this order: /json still lists a closing probe page for a moment, and
    // firstPageTarget must not pick it.
    const initialTarget = await this.firstPageTarget()
    this.identity = await this.nativeIdentity()
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

  activeDownloads(): readonly ArrivingDownload[] {
    return this.downloads?.active() ?? []
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
        const version = await httpJson<{
          webSocketDebuggerUrl?: string
          'User-Agent'?: string
          Browser?: string
        }>(`http://127.0.0.1:${this.port}/json/version`)
        if (version.webSocketDebuggerUrl) {
          // Read here because every page attach needs the result.
          this.userAgent = presentableUserAgent(version['User-Agent'] ?? '')
          this.browserBuild = `${this.opts.executablePath}|${version.Browser ?? ''}`
          return version.webSocketDebuggerUrl
        }
      } catch {
        // Chrome is still starting.
      }
      await sleep(100)
    }
    throw new Error('Chrome browser target never appeared')
  }

  private async nativeIdentity(): Promise<NativeIdentity | null> {
    const known = identityByBuild.get(this.browserBuild)
    if (known || !this.browserCdp) return known ?? null
    // Before Target discovery starts, so the probe page is never taken for a popup.
    const identity = await readNativeIdentity(
      cdpIdentityProbe(this.browserCdp, async (targetId) => {
        return (await this.targetById(targetId)).webSocketDebuggerUrl
      })
    )
    if (identity) identityByBuild.set(this.browserBuild, identity)
    return identity
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
    cdp.on('Runtime.bindingCalled', (params) => this.onBindingCalled(page, params))

    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await this.watchCopies(cdp)
    // Before anything navigates: tell a sign-in page the truth about this
    // browser. It advertised HeadlessChrome and claimed a platform
    // authenticator it does not have, which left Google waiting forever on a
    // passkey no Touch ID could ever answer. See browser-signin.ts.
    await applySignInCompatibility(cdp, { userAgent: this.userAgent, identity: this.identity })
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
    const internal = internalPageKind(info.url ?? '')
    if (internal === 'browser-ui') return
    if (internal === 'page') {
      // Chrome opened one of its own pages unasked: after a Google sign-in it
      // put chrome://settings/help in front of the card (owner 2026-11-09).
      // Nobody here can act on it, so it is closed, never made a tab.
      await this.browserCdp?.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined)
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
    const url = observedBrowserUrl(page.url, info.url || page.url)
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
    if (previous && previous !== next) {
      await this.stopScreencast(previous)
      // Another tab: the old one's picture and its screencast's clock are no heartbeat here.
      this.lastEmitted = null
      this.lastScreencastAt = 0
    }
    if (previous && previous !== next && this.fieldListeners.size > 0) this.setFieldWatch(previous, false)
    this.activeTabId = tabId
    this.lastHash = ''
    this.lastFields = null
    if (this.fieldListeners.size > 0) this.setFieldWatch(next, true)
    await this.browserCdp?.send('Target.activateTarget', { targetId: next.targetId })
    await this.ensureScreencast(next)
    await this.refreshPageState(next)
  }

  /** The quality and size the active screencast must run with now. */
  private castKey(): string {
    return `${this.frameQuality()} ${Math.round(this.width * this.scale)}x${Math.round(this.height * this.scale)}`
  }

  /**
   * EVERY SCREENCAST START AND STOP, ONE AT A TIME. A quality change, a viewport
   * change and a quiet screencast each stop and start it, and interleaved they
   * could leave it started at the old size with the flag saying all was well
   * (review 11-24). Queued, each one reads what the stream must be when its
   * turn comes, so the last one always leaves it right.
   */
  private castOp(op: () => Promise<void>): Promise<void> {
    const run = this.castTail.then(op)
    this.castTail = run.catch(() => undefined)
    return run
  }

  private castTail: Promise<void> = Promise.resolve()

  /**
   * The page's screencast running with what it must have now (castKey), and
   * started again if not. `fresh`: started again in any case. A screencast that
   * has gone quiet answers a restart with a fresh frame of its own: the same
   * pipeline, the same geometry, so a page that did not change comes back as the
   * same picture. A screenshot is another picture (1400 rows where the
   * screencast had 1398, measured 11-24), which every viewer had to be sent, and
   * an H.264 viewer as a two-pixel shift of it all.
   */
  private ensureScreencast(page: PageBinding, fresh = false): Promise<void> {
    return this.castOp(async () => {
      const gone = (): boolean => this.closed || page.closing || this.activeTabId !== page.tabId
      if (gone()) return
      const key = this.castKey()
      if (page.screencasting && page.castKey === key && !fresh) return
      if (page.screencasting) {
        await page.cdp.send('Page.stopScreencast').catch(() => undefined)
        page.screencasting = false
      }
      if (gone()) return
      this.streamQuality = this.frameQuality()
      await page.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.streamQuality,
        maxWidth: Math.round(this.width * this.scale),
        maxHeight: Math.round(this.height * this.scale),
        everyNthFrame: 1
      })
      page.screencasting = true
      page.castKey = key
    })
  }

  private stopScreencast(page: PageBinding): Promise<void> {
    return this.castOp(async () => {
      if (!page.screencasting) return
      await page.cdp.send('Page.stopScreencast').catch(() => undefined)
      page.screencasting = false
    })
  }

  /**
   * The page's copies, caught where they happen (page-copy.ts): a binding the
   * page calls, and the script that calls it in every document — the one
   * already loaded too. Best effort: a page that refuses it still works, it
   * only copies onto this Chrome's clipboard as before.
   */
  private async watchCopies(cdp: CdpClient): Promise<void> {
    try {
      await cdp.send('Runtime.addBinding', { name: COPY_BINDING })
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_COPY_SCRIPT })
      await cdp.send('Runtime.evaluate', { expression: PAGE_COPY_SCRIPT })
    } catch (error) {
      console.error('Watching a browser card page for copies failed:', error)
    }
    try {
      await cdp.send('Runtime.addBinding', { name: FIELDS_BINDING })
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_FIELDS_SCRIPT })
      await cdp.send('Runtime.evaluate', { expression: PAGE_FIELDS_SCRIPT })
    } catch (error) {
      console.error('Watching a browser card page for its text fields failed:', error)
    }
  }

  /** Switch the page's field reports on or off (page-fields.ts); best effort. */
  private setFieldWatch(page: PageBinding, on: boolean): void {
    void page.cdp
      .send('Runtime.evaluate', { expression: `window.${FIELDS_WATCH} && window.${FIELDS_WATCH}(${on ? 'true' : 'false'})` })
      .catch(() => undefined)
  }

  /** Watch where the active page's text fields are; the listener hears the last report at once. */
  watchFields(listener: (report: FieldReport) => void): () => void {
    const first = this.fieldListeners.size === 0
    this.fieldListeners.add(listener)
    const page = this.pages.get(this.activeTabId)
    if (first && page) this.setFieldWatch(page, true)
    else if (this.lastFields) listener(this.lastFields)
    return () => {
      if (!this.fieldListeners.delete(listener) || this.fieldListeners.size > 0) return
      const active = this.pages.get(this.activeTabId)
      if (active && !this.closed) this.setFieldWatch(active, false)
    }
  }

  /**
   * The viewer's paste. A real paste event first (an editor may format or
   * take it); typed in with Input.insertText when the page leaves it alone.
   * The text goes into a fixed call as a JSON literal — never as code.
   */
  async paste(text: string): Promise<void> {
    const page = this.pages.get(this.activeTabId)
    if (!page) return
    const answer = (await page.cdp
      .send('Runtime.evaluate', {
        expression: `typeof window.${PASTE_FUNCTION} === 'function' && window.${PASTE_FUNCTION}(${JSON.stringify(text)})`,
        returnByValue: true
      })
      .catch(() => null)) as RuntimeEvaluateResult | null
    if (answer?.result?.value === true) return
    await page.cdp.send('Input.insertText', { text }).catch(() => undefined)
  }

  /** A copy on the page the viewers are looking at; a background tab's is nobody's. */
  private onBindingCalled(page: PageBinding, params: Record<string, unknown>): void {
    if (params.name === FIELDS_BINDING) return this.onFieldsCalled(page, params.payload)
    if (params.name !== COPY_BINDING || page.tabId !== this.activeTabId) return
    const text = copyText(params.payload)
    if (text === null) return
    for (const listener of this.copyListeners) listener(text)
  }

  /** A page said hello (switch it on if someone watches) or reported its fields. */
  private onFieldsCalled(page: PageBinding, payload: unknown): void {
    if (page.tabId !== this.activeTabId) return
    if (payload === 'hello') {
      if (this.fieldListeners.size > 0) this.setFieldWatch(page, true)
      return
    }
    const report = sanitizeFieldReport(payload)
    if (!report) return
    this.lastFields = report
    for (const listener of this.fieldListeners) listener(report)
  }

  private onScreencastFrame(page: PageBinding, params: Record<string, unknown>): void {
    const sessionId = params.sessionId as number
    void page.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined)
    if (page.tabId !== this.activeTabId || this.viewportCoordinator.state.transitioning) return
    const data = params.data
    if (typeof data === 'string' && data.length > 0) {
      this.lastScreencastAt = Date.now()
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
    const clip = this.scale > 1 ? await this.oneXClip(page) : null
    const shot = (await page.cdp
      .send('Page.captureScreenshot', { format: 'jpeg', quality: 55, ...(clip ? { clip } : {}) })
      .catch(() => null)) as { data?: string } | null
    return typeof shot?.data === 'string' && shot.data.length > 0 ? shot.data : null
  }

  /**
   * The visible page at 1x. The card's picture goes to the phone too, over the
   * relay, and a 2x desktop owner (cast-viewport.ts · scale) must not make it
   * four times the bytes. Null — a plain capture — when the page will not say
   * where its viewport is.
   */
  private async oneXClip(
    page: PageBinding
  ): Promise<{ x: number; y: number; width: number; height: number; scale: number } | null> {
    const metrics = (await page.cdp.send('Page.getLayoutMetrics').catch(() => null)) as {
      cssVisualViewport?: { pageX?: unknown; pageY?: unknown; clientWidth?: unknown; clientHeight?: unknown }
    } | null
    const viewport = metrics?.cssVisualViewport
    const values = [viewport?.pageX, viewport?.pageY, viewport?.clientWidth, viewport?.clientHeight]
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
    const [x, y, width, height] = values as number[]
    if (width <= 0 || height <= 0) return null
    return { x, y, width, height, scale: 1 / this.scale }
  }

  private async pollTick(): Promise<void> {
    if (
      this.closed ||
      this.frameListeners.size === 0 ||
      this.viewportCoordinator.state.transitioning
    ) return
    const now = Date.now()
    if (now - this.lastFrameAt < POLL_INTERVAL_MS) return
    // A LIVE SCREENCAST IS NOT PHOTOGRAPHED. A screenshot makes the screencast
    // draw a frame of its own, a little different (another quality, two rows
    // shorter), and the two chased each other: eight new pictures a second of a
    // page nobody touched (measured 11-24), each a whole JPEG to every viewer and
    // an H.264 key frame when the size flipped. Once the screencast has spoken, a
    // still page is its last picture said again, and a screencast quiet for
    // SCREENCAST_STALL_MS is started again rather than photographed. A
    // screenshot is only for a screencast that has said nothing yet, or nothing
    // since the viewport changed: its first frame of the new size can be lost to
    // the change itself, and a still page would send no other (review 11-24).
    const page = this.pages.get(this.activeTabId)
    if (!page) return
    const last = this.lastEmitted
    if (this.lastScreencastAt > 0 && last && last.revision === this.viewportCoordinator.state.revision) {
      if (now - this.lastScreencastAt >= SCREENCAST_STALL_MS && page.screencasting) {
        this.lastScreencastAt = now
        void this.ensureScreencast(page, true).catch((error: unknown) => console.error('Restarting a quiet card screencast failed:', error))
      }
      // Hashed only when a heartbeat is due: the same picture again is no news before that.
      if (now - this.lastFrameAt >= STATIC_FRAME_HEARTBEAT_MS) this.emitFrame(last.base64, last.meta)
      return
    }
    const screencastBefore = this.lastScreencastAt
    try {
      const [shot, layout] = await Promise.all([
        page.cdp.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: this.frameQuality()
        }).catch(() => null) as Promise<{ data?: string } | null>,
        page.cdp.send('Page.getLayoutMetrics').catch(() => null) as Promise<{
          visualViewport?: { scale?: unknown }
          cssVisualViewport?: { pageY?: unknown }
        } | null>
      ])
      // The screencast answered while the picture was taken: it is alive, and its
      // picture of the same page stands. Sending this one too is the chase again.
      if (this.lastScreencastAt !== screencastBefore) return
      const scale = layout?.visualViewport?.scale
      if (shot?.data && typeof scale === 'number' && Number.isFinite(scale) && scale > 0) {
        const pageY = layout?.cssVisualViewport?.pageY
        this.emitFrame(shot.data, {
          pageScaleFactor: scale,
          ...(typeof pageY === 'number' && Number.isFinite(pageY) ? { scrollOffsetY: pageY } : {})
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
    this.lastEmitted = { base64, meta, revision: viewport.revision }
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
        const url = observedBrowserUrl(
          page.url,
          typeof state.url === 'string' ? state.url : page.url
        )
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

  /** Set cookies in this card's browser now (a running instance); rejects when the browser is not attached. */
  async setCookies(cookies: readonly HeadlessCookie[]): Promise<void> {
    if (this.browserCdp === null) throw new Error('The browser is not running.')
    await this.browserCdp.send('Storage.setCookies', { cookies })
  }

  /** Every cookie in this card's browser, session ones included (Storage.getCookies, default context); rejects when it is not attached. */
  async getCookies(): Promise<readonly unknown[]> {
    if (this.browserCdp === null) throw new Error('The browser is not running.')
    const answer = (await this.browserCdp.send('Storage.getCookies', {})) as { cookies?: unknown } | null
    return Array.isArray(answer?.cookies) ? answer.cookies : []
  }

  /** Update the node-card fallback without clobbering a viewer-owned viewport. */
  async resize(width: number, height: number): Promise<void> {
    this.viewportCoordinator.setDefault({ width, height, mobile: false })
  }

  private async applyViewportMetrics(metrics: ViewportMetrics): Promise<void> {
    if (this.closed) throw new Error('headless browser is closed')
    const active = this.pages.get(this.activeTabId)
    if (active) await this.stopScreencast(active)
    this.width = metrics.width
    this.height = metrics.height
    this.mobile = metrics.mobile
    this.scale = metrics.scale ?? 1
    this.lastHash = ''
    for (const page of this.pages.values()) await this.resizePage(page, metrics)
    if (active) await this.activatePage(active.tabId)
  }

  private async resizePage(
    page: PageBinding,
    metrics: ViewportMetrics = { width: this.width, height: this.height, mobile: this.mobile, scale: this.scale }
  ): Promise<void> {
    await page.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: metrics.width,
      height: metrics.height,
      deviceScaleFactor: metrics.scale ?? 1,
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

  /** Resolves once Chrome has taken the command; a pinch step is animated, so its caller paces on this. */
  dispatchInput(method: CdpInputCommand['method'], params: CdpInputCommand['params']): Promise<void> {
    const page = this.pages.get(this.activeTabId)
    if (!page) return Promise.resolve()
    return page.cdp.send(method, params).then(() => undefined, () => undefined)
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
    for (const timer of this.qualityReleases.values()) clearTimeout(timer)
    this.qualityReleases.clear()
    this.frameListeners.clear()
    this.copyListeners.clear()
    this.fieldListeners.clear()
    this.viewportCoordinator.dispose()
    for (const page of this.pages.values()) {
      page.closing = true
      page.cdp.close()
    }
    this.pages.clear()
    this.targetToTab.clear()
    this.programmaticTargetIds.clear()
    this.deferredTargetCreates.clear()
    const browserCdp = this.browserCdp
    this.browserCdp = null

    const proc = this.proc
    const pid = proc?.pid ?? null
    this.stopPromise = this.terminateProcess(proc, pid, gracefulTimeoutMs, browserCdp)
    return this.stopPromise
  }

  /**
   * CHROME IS ASKED TO CLOSE BEFORE IT IS SIGNALLED, so its cookies reach the
   * profile. Chrome writes cookies to disk lazily and a signal skips that:
   * measured on Chrome 158 (11-24), a cookie set just before the stop was gone
   * after a restart 7 times in 8 under SIGTERM, and kept 8 in 8 after CDP
   * Browser.close. localStorage survived both. A login made moments before a
   * card closed or the app quit came back signed out. The signals stay as the
   * fallback for a Chrome that will not answer.
   */
  private async terminateProcess(
    proc: ChildProcess | null,
    pid: number | null,
    gracefulTimeoutMs: number,
    browserCdp: Pick<CdpClient, 'send' | 'close'> | null = null
  ): Promise<HeadlessStopResult> {
    if (!proc || processExited(proc)) {
      browserCdp?.close()
      return { pid, forced: false }
    }
    if (browserCdp && gracefulTimeoutMs > 0) {
      // Chrome may drop the line before it answers; the exit is the answer. A loaded
      // machine gets longer: running out the wait is the signal, and the signal is
      // what loses the cookies (a real-Chrome run at load 60 did, 11-24).
      void browserCdp.send('Browser.close').catch(() => undefined)
      const closed = await waitForProcessExit(proc, Math.max(gracefulTimeoutMs, CLOSE_ASK_TIMEOUT_MS))
      browserCdp.close()
      if (closed) return { pid, forced: false }
    } else {
      browserCdp?.close()
    }
    try {
      proc.kill('SIGTERM')
    } catch {
      // The bounded wait below distinguishes a raced exit from a live child.
    }

    const exitedGracefully =
      gracefulTimeoutMs > 0
        ? await waitForProcessExit(proc, browserCdp ? FORCED_SHUTDOWN_TIMEOUT_MS : gracefulTimeoutMs)
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
