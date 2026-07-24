// Headless-Chromium instance manager (interactive remote browser, single
// instance). Spawns a --headless=new installed Chrome with a PERSISTENT
// profile + the throttle-defeating flags, attaches ONE CDP client, and streams
// Page.startScreencast frames. A real headless Chrome is never composited, so —
// unlike an occluded Electron <webview> — its compositor never idles and frames
// flow continuously. ONE instance per browser id is shared by every viewer AND
// the agent (a separate CDP client on the same --remote-debugging-port), so
// cookies / session / DOM are unified for human-in-the-loop login.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { CdpClient } from './cdp-client'

/** GET a small JSON body over http (Electron main lacks a reliable global fetch). */
function httpJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as T)
        } catch (e) {
          reject(e as Error)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('timeout')))
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Gap-filling capture poll (~15fps). Page.startScreencast is EVENT-driven and,
 * on a host WITHOUT a display (local macOS headless), only fires on input — so
 * server/timer-driven changes (OAuth redirect, login-success flip, a
 * notification) never paint. A periodic Page.captureScreenshot forces a paint of
 * the layout tree, catching those non-input DOM/navigation changes. Where a
 * display exists (Linux/cloud, Xvfb) startScreencast flows continuously and the
 * poll is suppressed (a recent screencast frame skips the tick). Frames are
 * hash-deduped so identical captures are never re-sent. Known limit: smooth
 * compositor-only animation (canvas rAF / <video>) still won't tick without a
 * display — the WebRTC/video escape hatch.
 */
const POLL_INTERVAL_MS = 66

/**
 * Locate an installed Chromium-family browser (fork decision: reuse installed
 * Chrome for the prototype; bundling/notarization deferred). `COOKREW_CHROME_PATH`
 * overrides; otherwise probe the common per-OS locations.
 */
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
  return candidates.find((p) => existsSync(p)) ?? null
}

/** Flags that stop Chromium suspending an unfocused/occluded/backgrounded page. */
const THROTTLE_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling'
]

export interface HeadlessOptions {
  executablePath: string
  /** Persistent profile dir (cookies/session survive restarts) — NOT /tmp. */
  profileDir: string
  width: number
  height: number
  /** URL the instance opens on first launch. */
  url: string
  quality?: number
}

export interface FrameMeta {
  deviceWidth?: number
  deviceHeight?: number
}

/** A running headless Chrome + its single screencast CDP client. */
export class HeadlessInstance {
  private proc: ChildProcess | null = null
  private cdp: CdpClient | null = null
  private port = 0
  private closed = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  /** Epoch ms of the last EMITTED (deduped) frame — suppresses poll ticks. */
  private lastFrameAt = 0
  /** Hash of the last emitted frame — drops identical captures. */
  private lastHash = ''
  /** Fan-out sinks — each viewer registers one; CDP is acked independently. */
  readonly frameListeners = new Set<(jpegBase64: string, meta: FrameMeta) => void>()
  onExit: () => void = () => undefined

  constructor(private readonly opts: HeadlessOptions) {}

  async start(): Promise<void> {
    mkdirSync(this.opts.profileDir, { recursive: true })
    // A prior instance killed with SIGKILL leaves stale single-instance locks +
    // a stale DevToolsActivePort; a fresh Chrome on the SAME persistent profile
    // then can't claim it. Clear them (we ref-count to one instance per profile,
    // so nothing valid is holding them here). Cookies/session are untouched.
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) {
      try {
        rmSync(path.join(this.opts.profileDir, f), { force: true })
      } catch {
        // best effort
      }
    }
    const args = [
      '--headless=new',
      `--user-data-dir=${this.opts.profileDir}`,
      '--remote-debugging-port=0', // Chrome picks a free port, writes it to disk
      `--window-size=${this.opts.width},${this.opts.height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      ...THROTTLE_FLAGS,
      this.opts.url
    ]
    this.proc = spawn(this.opts.executablePath, args, { stdio: 'ignore' })
    this.proc.on('exit', () => {
      if (!this.closed) this.onExit()
    })

    this.port = await this.readDevToolsPort()
    const targetWs = await this.pageTargetWs()
    const cdp = new CdpClient()
    cdp.onClose = () => {
      if (!this.closed) this.onExit()
    }
    await cdp.connect(targetWs)
    this.cdp = cdp
    cdp.on('Page.screencastFrame', (params) => this.onScreencastFrame(params))
    await cdp.send('Page.enable')
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.opts.quality ?? 60,
      maxWidth: this.opts.width,
      maxHeight: this.opts.height,
      everyNthFrame: 1
    })
    // Gap-filling poll for non-input changes on a display-less host (macOS).
    this.pollTimer = setInterval(() => void this.pollTick(), POLL_INTERVAL_MS)
  }

  /** Chrome writes its chosen debugging port to DevToolsActivePort line 1. */
  private async readDevToolsPort(): Promise<number> {
    const file = path.join(this.opts.profileDir, 'DevToolsActivePort')
    for (let i = 0; i < 150; i += 1) {
      if (this.closed) throw new Error('instance closed during startup')
      if (existsSync(file)) {
        const port = Number(readFileSync(file, 'utf8').split('\n')[0]?.trim())
        if (Number.isFinite(port) && port > 0) return port
      }
      await sleep(100)
    }
    throw new Error('Chrome DevTools port never appeared')
  }

  /** Discover the page target's websocket via the /json HTTP endpoint. */
  private async pageTargetWs(): Promise<string> {
    for (let i = 0; i < 100; i += 1) {
      if (this.closed) throw new Error('instance closed during startup')
      try {
        const targets = await httpJson<Array<{ type?: string; webSocketDebuggerUrl?: string }>>(
          `http://127.0.0.1:${this.port}/json`
        )
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
      } catch {
        // Chrome not serving /json yet
      }
      await sleep(100)
    }
    throw new Error('no page target found')
  }

  private onScreencastFrame(params: Record<string, unknown>): void {
    const data = params.data as string
    const sessionId = params.sessionId as number
    // ACK IMMEDIATELY — CDP must never be backpressured by a slow client
    // (fan-out rule): one slow phone can't stall the shared instance.
    void this.cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined)
    if (!data) return
    this.emitFrame(data, (params.metadata ?? {}) as FrameMeta)
  }

  /** Poll tick — force a paint to catch non-input changes when screencast is quiet. */
  private async pollTick(): Promise<void> {
    if (this.closed || this.frameListeners.size === 0) return
    // A recent screencast frame already covered this window (display present).
    if (Date.now() - this.lastFrameAt < POLL_INTERVAL_MS) return
    try {
      const shot = (await this.cdp?.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: this.opts.quality ?? 60
      })) as { data?: string } | undefined
      if (shot?.data) this.emitFrame(shot.data, {})
    } catch {
      // capture failed (navigating / gone) — the next tick retries
    }
  }

  /** Dedup by hash, then fan out to every viewer. */
  private emitFrame(base64: string, meta: FrameMeta): void {
    if (this.closed) return
    const hash = createHash('md5').update(base64).digest('base64')
    if (hash === this.lastHash) return // identical frame — don't re-send
    this.lastHash = hash
    this.lastFrameAt = Date.now()
    for (const listener of this.frameListeners) listener(base64, meta)
  }

  /** Deliver ONE whitelisted CDP Input.* command to the shared instance. */
  dispatchInput(method: string, params: Record<string, unknown>): void {
    void this.cdp?.send(method, params).catch(() => undefined)
  }

  get devToolsPort(): number {
    return this.port
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.frameListeners.clear()
    try {
      this.cdp?.close()
    } catch {
      // already closed
    }
    try {
      this.proc?.kill('SIGKILL')
    } catch {
      // already dead
    }
  }
}
