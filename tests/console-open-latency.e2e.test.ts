import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DESKTOP, PHONE, launchBrowser, type Browser, type Tab, type Viewport } from './support/chrome-driver'
import { KITCHEN } from './support/console-machine'
import { bootConsoleStage, type ConsoleStage } from './support/console-stage'

/**
 * ENTERING A MACHINE ON THE CONSOLE, OVER A LONG ROUND TRIP (latency 0.6.1).
 *
 * The owner's console reaches api.cookrew.dev through a proxy at ~400 ms a
 * round trip (measured 2026-11-11, docs/latency-061.html), and every request a
 * page sends there with the session in a header is preflighted — once per
 * distinct URL, for as long as the browser keeps the answer. A page that asks
 * a machine forty different URLs pays forty preflights, and every one on the
 * chain to the first paint is a round trip added to it.
 *
 * This is the real built console, a real registry and a fixture machine on the
 * relay (support/console-stage.ts), in headless Chrome with the round trip the
 * owner has (Network.emulateNetworkConditions). It enters a machine by its
 * address at a phone's width and a desktop's, and holds:
 *
 *   every relayed call rides ONE address, so the browser asks its preflight
 *   once and never again for the whole visit, whatever the routes and queries;
 *   the machine's first paint is in time.
 *
 * GATED like the acceptance suite (COOKREW_CONSOLE_E2E=1): it builds the
 * console and drives Chrome.
 *
 *   COOKREW_CONSOLE_E2E=1 npx vitest run tests/console-open-latency.e2e.test.ts
 *   COOKREW_LATENCY_RTT_MS=400    the emulated round trip (default 400)
 */

const armed = process.env.COOKREW_CONSOLE_E2E === '1'
const suite = armed ? describe : describe.skip
const RTT_MS = Number(process.env.COOKREW_LATENCY_RTT_MS ?? 400)
const MINUTE = 60_000
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Row {
  url: string
  method: string
  type: string
  /** The machine's route of a call at the relay's one address, from its header. */
  route: string
  t0: number
  end: number | null
}

/** Every request a tab makes from now on, preflights included, in the network's own clock. */
function record(tab: Tab): { rows: Row[]; clear(): void } {
  const rows: Row[] = []
  const byId = new Map<string, Row>()
  tab.cdp.on('Network.requestWillBeSent', ((event: { requestId: string; type?: string; timestamp: number; request: { url: string; method: string; headers?: Record<string, string> } }) => {
    if (byId.has(event.requestId)) return
    const headers = Object.fromEntries(Object.entries(event.request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
    const row: Row = { url: event.request.url, method: event.request.method, type: event.type ?? '', route: headers['x-cookrew-route'] ?? '', t0: event.timestamp * 1000, end: null }
    byId.set(event.requestId, row)
    rows.push(row)
  }) as never)
  tab.cdp.on('Network.loadingFinished', ((event: { requestId: string; timestamp: number }) => {
    const row = byId.get(event.requestId)
    if (row) row.end = event.timestamp * 1000
  }) as never)
  return {
    rows,
    clear: () => {
      rows.length = 0
      byId.clear()
    }
  }
}

const isPreflight = (row: Row): boolean => row.method === 'OPTIONS' || row.type === 'Preflight'

suite.each([
  ['phone', PHONE],
  ['desktop', DESKTOP]
] as const)('entering a machine over a %s-width console at a long round trip', (_name, viewport: Viewport) => {
  let stage: ConsoleStage
  let browser: Browser
  let tab: Tab

  const onConsole = (pathname: string, why: string, ms = 30_000): Promise<unknown> =>
    tab.until(`location.origin === ${JSON.stringify(stage.host.origin)} && location.pathname === ${JSON.stringify(pathname)}`, why, ms)

  beforeAll(async () => {
    stage = await bootConsoleStage()
    browser = await launchBrowser()
    tab = await browser.open(viewport, stage.clock.offset())
    // Signed in and past the gate, as the owner's browser is (console-acceptance.e2e.test.ts steps 1-2).
    await tab.goto(`${stage.host.origin}/`)
    await tab.click('.cd-primary', 'Sign in')
    await tab.until(`location.origin === ${JSON.stringify(stage.site.A)} && document.querySelector('input[name=password]')`, 'the sign-in page')
    await tab.click('input[name=username]')
    await tab.type(stage.username)
    await tab.click('input[name=password]')
    await tab.type(stage.password)
    await tab.key('Enter')
    await tab.click('button.rung', 'Approve on another device')
    const match = await tab.until<string>(`(document.body.innerText.match(/(\\d{2,})\\s+TYPE THIS NUMBER/i) || [])[1]`, 'the number to type')
    const deadline = Date.now() + 15_000
    while (!(await stage.approveSignIn(match))) {
      if (Date.now() > deadline) throw new Error('the sign-in never reached the first machine')
      await sleep(200)
    }
    await onConsole('/', 'signed in')
    await tab.until(`document.querySelector('.cd-gate .cd-primary')`, 'the gate')
    await tab.click('.cd-gate .cd-primary', 'Use the account password')
    await tab.until(`location.origin === ${JSON.stringify(stage.site.A)} && document.querySelector('input[name=password]')`, 'the password page')
    await tab.click('input[name=password]')
    await tab.type(stage.password)
    await tab.key('Enter')
    await onConsole('/', 'past the gate')
    await tab.until(`document.querySelectorAll('.cd-tile[data-standing=live]').length >= 2`, 'the machines to answer', 30_000)
  }, 5 * MINUTE)

  afterAll(async () => {
    await browser?.close().catch(() => undefined)
    await stage?.close().catch(() => undefined)
  }, 2 * MINUTE)

  it('asks one preflight for the whole visit and paints the machine in time', async () => {
    const seen = record(tab)
    await tab.cdp.send('Network.emulateNetworkConditions', { offline: false, latency: RTT_MS, downloadThroughput: -1, uploadThroughput: -1 })
    // A fresh browser cache of preflights, as after ten minutes away.
    await tab.cdp.send('Network.clearBrowserCache')
    await tab.goto('about:blank')
    seen.clear()
    const started = Date.now()
    await tab.goto(`${stage.host.origin}/d/${stage.studio.deviceId}`)
    await tab.until(`document.querySelector('.zv-door')`, 'the machine’s workspaces', 60_000)
    const paintMs = Date.now() - started
    // What a visit asked, in order, when COOKREW_LATENCY_DUMP=1: the chain to read.
    const dump = (label: string, rows: readonly Row[]): void => {
      if (process.env.COOKREW_LATENCY_DUMP !== '1') return
      const zero = rows[0]?.t0 ?? 0
      console.info(`console-open-latency timeline: ${label}`)
      for (const row of rows) {
        const at = (ms: number | null): string => (ms === null ? '…' : String(Math.round(ms - zero)))
        console.info(`  ${at(row.t0).padStart(5)} → ${at(row.end).padStart(5)}  ${isPreflight(row) ? 'OPTIONS' : row.method.padEnd(7)} ${row.route || row.url.replace(stage.host.origin, '[console]').replace(stage.site.API, '[api]')}`)
      }
    }
    dump('to the workspaces', seen.rows)
    // Inside the machine, quietly, for a while: polls, streams and the path probe all run.
    await sleep(20_000)
    // And one level in, by its address: the workspace's agents drawn, which is the machine readable.
    const visit = seen.rows.slice()
    const inner = Date.now()
    await tab.goto(`${stage.host.origin}/d/${stage.studio.deviceId}/w/${KITCHEN}`)
    await tab.until(`document.querySelector('.zv-av')`, 'the workspace’s agents', 60_000)
    const agentsMs = Date.now() - inner
    dump('to the agents', seen.rows.slice(visit.length))
    const relayed = visit.filter((row) => row.url.startsWith(`${stage.site.API}/api/m`))
    const preflights = relayed.filter(isPreflight)
    const report = {
      rttMs: RTT_MS,
      width: viewport.width,
      paintMs,
      agentsMs,
      relayed: relayed.length - preflights.length,
      relayPreflights: preflights.length,
      distinctRelayUrls: new Set(relayed.filter((row) => !isPreflight(row)).map((row) => row.url)).size,
      // When each preflight went out, from the first request of the visit: a burst at the start is
      // concurrent first calls (a browser does not wait for one preflight to answer the others).
      preflightAtMs: preflights.map((row) => Math.round(row.t0 - (visit[0]?.t0 ?? row.t0))),
      // The registry's own routes are asked at their own URLs, a handful of them: once each, not once per call.
      registryPreflights: visit.filter((row) => isPreflight(row) && row.url.startsWith(`${stage.site.API}/v2/`)).length,
      registryCalls: visit.filter((row) => !isPreflight(row) && row.url.startsWith(`${stage.site.API}/v2/`)).length
    }
    console.info(`console-open-latency ${JSON.stringify(report)}`)
    expect(report.relayed, 'the machine was asked things').toBeGreaterThan(3)
    // One address: every relayed call of the visit at the same URL.
    expect(report.distinctRelayUrls, 'distinct relay URLs').toBe(1)
    // A browser does not hold its first calls for the first preflight's answer, so the calls that
    // leave together each ask one. After that answer nothing asks again for the rest of the visit
    // (before 0.6.1: 30 preflights in this visit, one every five seconds for ever).
    const first = report.preflightAtMs[0] ?? 0
    expect(report.relayPreflights, 'preflights on the relay for the whole visit').toBeLessThanOrEqual(4)
    expect(report.preflightAtMs.every((at) => at < first + RTT_MS), `every preflight inside the first round trip: ${report.preflightAtMs}`).toBe(true)
  }, 3 * MINUTE)
})
