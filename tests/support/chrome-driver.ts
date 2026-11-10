import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain JS helper shared with the perf probes: it reaps the Chrome it starts
import { connectCdp, launchChrome } from '../../scripts/perf-cdp.mjs'

/**
 * A REAL BROWSER, DRIVEN AS A PERSON DRIVES IT, for a suite that accepts a
 * page end to end. Headless Chrome from the repo's own launcher (which ties
 * the browser's life to this process and sweeps what an earlier run left), one
 * profile, any number of tabs.
 *
 * INPUT IS INPUT: a click is a mouse press and release at the middle of what
 * is on screen, typing is text inserted where the focus is, a key is a key.
 * Nothing here calls the page's own functions.
 *
 * EVERYTHING THAT WENT WRONG ON A PAGE IS KEPT (`problems`): a refused policy
 * directive with the address it blocked, an error the console printed, a
 * promise nobody caught, a request that failed or was answered 4xx/5xx. A
 * page that is reloaded or sent to another origin loses none of it: the page
 * reports through a binding, not into its own memory.
 */

export interface Problem {
  readonly kind: 'csp' | 'console' | 'exception' | 'rejection' | 'request-failed' | 'http'
  /** The page's address when it happened. */
  readonly page: string
  readonly text: string
  readonly at: number
}

export interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>
  on(method: string, listener: (params: never) => void): () => void
  close(): void
}

export interface Viewport {
  readonly width: number
  readonly height: number
  /** A phone: touch, and a mobile layout viewport. */
  readonly mobile: boolean
}

export const PHONE: Viewport = { width: 412, height: 915, mobile: true }
export const DESKTOP: Viewport = { width: 1440, height: 900, mobile: false }

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface Tab {
  readonly cdp: Cdp
  readonly problems: readonly Problem[]
  /** Every request this tab made, with its answer's status (0 while unanswered or failed). */
  readonly requests: readonly { url: string; method: string; status: number; at: number }[]
  goto(url: string): Promise<void>
  reload(): Promise<void>
  /** Browser Back, as the button does it. False when there is nothing to go back to. */
  back(): Promise<boolean>
  url(): Promise<string>
  evaluate<T>(expression: string): Promise<T>
  /** Wait until the expression is truthy; answers its value. Throws with `why` and what the page shows. */
  until<T>(expression: string, why: string, ms?: number): Promise<T>
  /** The box of the first match, scrolled into view; null when there is none on screen. */
  box(selector: string, text?: string | RegExp): Promise<Box | null>
  /** Press and release at the middle of the first visible match. */
  click(selector: string, text?: string | RegExp): Promise<void>
  clickAt(x: number, y: number): Promise<void>
  /** Text, into whatever has the focus. */
  type(text: string): Promise<void>
  key(key: 'Enter' | 'Escape' | 'Tab' | 'Backspace'): Promise<void>
  shot(file: string): Promise<void>
  /** The time this page reads, moved by `ms` from now on (and on every later load in this tab). */
  skew(ms: number): Promise<void>
  /** In front of the other tabs. */
  front(): Promise<void>
  /** How many documents this tab has loaded: a page that reloads itself is one more. */
  loads(): number
  text(): Promise<string>
  close(): Promise<void>
}

export interface Browser {
  /** A new tab. `skewMs`: the time its pages read, from their first line on. */
  open(viewport: Viewport, skewMs?: number): Promise<Tab>
  close(): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs in every document before its own scripts: what goes wrong is told to the driver as it happens. */
const WATCH = `(() => {
  const tell = (kind, text) => { try { window.__e2eTell(JSON.stringify({ kind, text: String(text).slice(0, 600), page: location.href })) } catch {} }
  addEventListener('securitypolicyviolation', (e) => tell('csp', e.effectiveDirective + ' blocked ' + (e.blockedURI || 'inline') + (e.sourceFile ? ' from ' + e.sourceFile + ':' + e.lineNumber : '')))
  addEventListener('error', (e) => { if (e.message) tell('exception', e.message + (e.filename ? ' at ' + e.filename + ':' + e.lineno : '')) })
  addEventListener('unhandledrejection', (e) => tell('rejection', (e.reason && (e.reason.stack || e.reason.message)) || e.reason))
  const real = Date.now.bind(Date)
  Date.now = () => real() + (Number(window.__e2eSkew) || 0)
})()`

const KEYS: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }
}

/** Every element on the page that matches and says what is wanted, as a page expression. */
const matches = (selector: string, text?: string | RegExp): string => {
  const wanted = text === undefined ? 'null' : text instanceof RegExp ? text.toString() : JSON.stringify(text)
  return `(() => {
    const wanted = ${wanted}
    const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const said = (el) => [(el.innerText || el.textContent || '').trim(), el.getAttribute('aria-label') || ''].join(' | ')
    const says = (el) => wanted === null || (wanted instanceof RegExp ? wanted.test(said(el)) : said(el).includes(wanted))
    return [...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => shown(el) && says(el))
  })()`
}

/**
 * WHERE A FINGER WOULD LAND: a point of a match that nothing else covers, the
 * middle first. Of several matches the one that can be touched as the page
 * stands is taken (a page keeps copies of a control under what is on top);
 * only when none can is the first brought into view, for the next look.
 */
const touchable = (selector: string, text?: string | RegExp): string => `(() => {
  const found = ${matches(selector, text)}
  const steps = [0.5, 0.25, 0.75, 0.1, 0.9]
  for (const el of found) {
    const r = el.getBoundingClientRect()
    for (const fy of steps) for (const fx of steps) {
      const x = r.x + r.width * fx, y = r.y + r.height * fy
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
      const top = document.elementFromPoint(x, y)
      if (top && (top === el || el.contains(top))) return { x, y, width: r.width, height: r.height, left: r.x, top: r.y }
    }
  }
  if (found[0]) found[0].scrollIntoView({ block: 'center', inline: 'center' })
  return null
})()`

export async function launchBrowser(): Promise<Browser> {
  const profile = mkdtempSync(path.join(tmpdir(), 'cookrew-console-e2e-chrome-'))
  const chrome = (await launchChrome({ userDataDir: profile })) as { child: { kill(signal: string): void; exitCode: number | null; once(event: string, listener: () => void): void }; port: number; browserWs: string }
  const browser = (await connectCdp(chrome.browserWs)) as Cdp
  const tabs = new Set<Tab>()

  const open = async (viewport: Viewport, startSkewMs = 0): Promise<Tab> => {
    const made = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    const cdp = (await connectCdp(`ws://127.0.0.1:${chrome.port}/devtools/page/${made.targetId}`)) as Cdp
    const problems: Problem[] = []
    const requests: { url: string; method: string; status: number; at: number }[] = []
    const byId = new Map<string, number>()
    let at = 'about:blank'
    let skewMs = 0
    let skewScript: string | null = null
    let loadCount = 0
    const note = (kind: Problem['kind'], text: string, page = at): void => void problems.push({ kind, page, text, at: Date.now() })

    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Log.enable')
    await cdp.send('Runtime.addBinding', { name: '__e2eTell' })
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH })
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.mobile ? 2 : 1, mobile: viewport.mobile })
    if (viewport.mobile) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

    cdp.on('Runtime.bindingCalled', ((event: { name: string; payload: string }) => {
      if (event.name !== '__e2eTell') return
      try {
        const told = JSON.parse(event.payload) as { kind: Problem['kind']; text: string; page: string }
        note(told.kind, told.text, told.page)
      } catch {
        // Not ours.
      }
    }) as never)
    cdp.on('Page.frameNavigated', ((event: { frame: { parentId?: string; url: string } }) => {
      if (event.frame.parentId === undefined) at = event.frame.url
    }) as never)
    cdp.on('Page.loadEventFired', (() => {
      loadCount += 1
    }) as never)
    cdp.on('Page.navigatedWithinDocument', ((event: { url: string }) => {
      at = event.url
    }) as never)
    cdp.on('Runtime.consoleAPICalled', ((event: { type: string; args: { value?: unknown; description?: string }[] }) => {
      if (event.type !== 'error' && event.type !== 'assert') return
      note('console', event.args.map((arg) => (typeof arg.value === 'string' ? arg.value : (arg.description ?? JSON.stringify(arg.value)))).join(' ').slice(0, 600))
    }) as never)
    cdp.on('Log.entryAdded', ((event: { entry: { level: string; source: string; text: string; url?: string } }) => {
      if (event.entry.level !== 'error') return
      // A failed load is kept once, by the network's own account of it (below).
      if (event.entry.source === 'network') return
      note(event.entry.source === 'security' && /Content Security Policy/i.test(event.entry.text) ? 'csp' : 'console', `${event.entry.text}${event.entry.url ? ` (${event.entry.url})` : ''}`.slice(0, 600))
    }) as never)
    cdp.on('Network.requestWillBeSent', ((event: { requestId: string; request: { url: string; method: string } }) => {
      byId.set(event.requestId, requests.length)
      requests.push({ url: event.request.url, method: event.request.method, status: 0, at: Date.now() })
    }) as never)
    cdp.on('Network.responseReceived', ((event: { requestId: string; response: { status: number; url: string } }) => {
      const index = byId.get(event.requestId)
      if (index !== undefined) requests[index] = { ...requests[index], status: event.response.status }
      if (event.response.status >= 400) note('http', `${event.response.status} ${requests[index ?? -1]?.method ?? 'GET'} ${event.response.url}`)
    }) as never)
    cdp.on('Network.loadingFailed', ((event: { requestId: string; errorText: string; canceled?: boolean; blockedReason?: string }) => {
      const index = byId.get(event.requestId)
      const request = index === undefined ? null : requests[index]
      // A request the page itself gave up on (a stream closed, a navigation) is not a failure.
      if (event.canceled === true && event.blockedReason === undefined) return
      note(event.blockedReason === 'csp' ? 'csp' : 'request-failed', `${event.blockedReason ? `blocked (${event.blockedReason}) ` : ''}${event.errorText} ${request?.method ?? ''} ${request?.url ?? ''}`.trim())
    }) as never)

    const evaluate = async <T>(expression: string): Promise<T> => {
      const out = await cdp.send<{ result?: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (out.exceptionDetails) throw new Error(`page evaluation failed: ${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`)
      return out.result?.value as T
    }
    const text = (): Promise<string> => evaluate<string>('document.body ? document.body.innerText : ""').catch(() => '')
    const until = async <T>(expression: string, why: string, ms = 15_000): Promise<T> => {
      const deadline = Date.now() + ms
      let last: unknown = null
      for (;;) {
        try {
          // An element is an answer of yes: it cannot be carried out of the page by value.
          const value = await evaluate<T>(`(() => { const found = (${expression}); return found instanceof Node ? true : found })()`)
          if (value) return value
        } catch (error) {
          // A page between two documents has no context to ask: asked again.
          last = error
        }
        if (Date.now() > deadline) {
          const shown = (await text()).replace(/\s+/g, ' ').slice(0, 400)
          throw new Error(`timed out after ${ms} ms waiting for ${why}. At ${at}. The page shows: ${JSON.stringify(shown)}${last ? ` (${String(last)})` : ''}`)
        }
        await sleep(100)
      }
    }
    const box = async (selector: string, wanted?: string | RegExp): Promise<Box | null> => {
      for (let look = 0; look < 2; look += 1) {
        const found = await evaluate<{ left: number; top: number; width: number; height: number } | null>(touchable(selector, wanted))
        if (found !== null) return { x: found.left, y: found.top, width: found.width, height: found.height }
      }
      return null
    }
    const clickAt = async (x: number, y: number): Promise<void> => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    }
    const loaded = async (run: () => Promise<unknown>): Promise<void> => {
      let done: () => void = () => undefined
      const fired = new Promise<void>((resolve) => {
        done = resolve
      })
      const off = cdp.on('Page.loadEventFired', (() => done()) as never)
      try {
        await run()
        await Promise.race([fired, sleep(20_000)])
      } finally {
        off()
      }
    }

    const tab: Tab = {
      cdp,
      problems,
      requests,
      goto: (url) => loaded(() => cdp.send('Page.navigate', { url })),
      reload: () => loaded(() => cdp.send('Page.reload', {})),
      back: async () => {
        const history = await cdp.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory')
        if (history.currentIndex <= 0) return false
        await cdp.send('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex - 1].id })
        return true
      },
      url: () => evaluate<string>('location.href'),
      evaluate,
      until,
      box,
      click: async (selector, wanted) => {
        const what = `${selector}${wanted === undefined ? '' : ` saying ${String(wanted)}`}`
        // A control that is still moving (a box unfolding, a sheet sliding in) is not pressed where it was: a finger waits for it too.
        let point = await until<{ x: number; y: number }>(touchable(selector, wanted), `${what} to be on screen with nothing over it`)
        for (let look = 0; look < 40; look += 1) {
          await sleep(80)
          const again = await evaluate<{ x: number; y: number } | null>(touchable(selector, wanted)).catch(() => null)
          if (again !== null && Math.abs(again.x - point.x) < 1 && Math.abs(again.y - point.y) < 1) break
          if (again !== null) point = again
        }
        await clickAt(point.x, point.y)
      },
      clickAt,
      type: async (typed) => void (await cdp.send('Input.insertText', { text: typed })),
      key: async (key) => {
        const spec = KEYS[key]
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode })
      },
      shot: async (file) => {
        mkdirSync(path.dirname(file), { recursive: true })
        const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
        writeFileSync(file, Buffer.from(shot.data, 'base64'))
      },
      skew: async (ms) => {
        skewMs += ms
        if (skewScript !== null) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: skewScript })
        skewScript = (await cdp.send<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', { source: `window.__e2eSkew = ${skewMs}` })).identifier
        await evaluate(`void (window.__e2eSkew = ${skewMs})`)
      },
      front: async () => void (await cdp.send('Page.bringToFront')),
      loads: () => loadCount,
      text,
      close: async () => {
        tabs.delete(tab)
        cdp.close()
        await browser.send('Target.closeTarget', { targetId: made.targetId }).catch(() => undefined)
      }
    }
    tabs.add(tab)
    if (startSkewMs !== 0) await tab.skew(startSkewMs)
    return tab
  }

  return {
    open,
    close: async () => {
      for (const tab of tabs) tab.cdp.close()
      browser.close()
      const gone = new Promise<void>((resolve) => chrome.child.once('exit', () => resolve()))
      chrome.child.kill('SIGKILL')
      if (chrome.child.exitCode === null) await Promise.race([gone, sleep(5000)])
      // Its helpers let go of the profile a moment after the browser dies.
      for (let turn = 0; turn < 10; turn += 1) {
        try {
          rmSync(profile, { recursive: true, force: true })
          break
        } catch {
          await sleep(200)
        }
      }
    }
  }
}
