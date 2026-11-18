import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromeBinary, connectCdp, launchChrome, pageTarget, type CdpClient } from '../../scripts/perf-cdp.mjs'
import { FIRST_CARD_SELECTOR, bootCharged, requestKind } from '../../scripts/perf-remote-open.mjs'
import { REMOTE_OPEN } from './budgets'
import { builtRendererPresent, rendererDir, startFixtureCompanion, type FixtureCompanion, type FixtureRequest } from './remote-open-fixture'

/**
 * THE REMOTE BOOT, COUNTED (perf lane L7).
 *
 * A phone opening its canvas through cookrew.dev pays one relay exchange per
 * request, so what the boot ASKS FOR is the cost. This gate serves the built
 * renderer from a fixture companion to a headless Chrome and counts every
 * request until the first card is drawn, plus the two seconds after it (the
 * window in which the activity snapshot lands and the overview fit settles).
 * Every assertion is structural. The clock is reported, never asserted: a
 * request count is what no machine can fake.
 *
 * THE FIRST CARD is the zoom view's agent (FIRST_CARD_SELECTOR, shared with
 * the nightly recorder). It was a canvas card until the canvas was retired on
 * 2026-10-30; from then the marker never fired, the window was empty, and
 * every count below passed on nothing. So every count now REQUIRES a card:
 * no card, no window, and each test fails saying so.
 *
 * WHAT IS CHARGED is one rule shared with the nightly (perf-remote-open.mjs ·
 * requestKind): streams and thumbnails are not requests of the boot; the
 * first beacon is, the 3 s heartbeat after it is not. Streams are counted
 * apart, by their openings: one each, held open — a stream that reconnects
 * in a loop is the regression a request budget would hide.
 *
 * Skips, loudly, without Chrome or without out/renderer (CI builds first).
 */

const OBSERVER = `(() => {
  const marks = { firstCard: null }
  window.__courier = marks
  const seen = () => {
    if (marks.firstCard === null && document.querySelector(${JSON.stringify(FIRST_CARD_SELECTOR)})) {
      marks.firstCard = Date.now()
      observer.disconnect()
    }
  }
  const observer = new MutationObserver(seen)
  document.addEventListener('DOMContentLoaded', () => { observer.observe(document.documentElement, { childList: true, subtree: true }); seen() })
})()`

/** phone-beacon.ts · BEACON_MS: the black box's clock. */
const BEACON_CLOCK_MS = 3000
/**
 * The boot window: first card plus this. Time-based, so it is CHECKED, not
 * assumed: the recording runs on well past it, and a boot request that lands
 * after it fails the gate (see "finished booting inside its window") instead
 * of quietly going uncounted on a slower runner. tests/perf/budgets.ts says why.
 */
const BOOT_WINDOW_MS = 2_000
/** How long the recording runs past first card: several beacon periods, so the streams and the clock are watched. */
const RECORD_AFTER_CARD_MS = Math.round(BEACON_CLOCK_MS * 3.5)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const pathnameOf = (p: string): string => p.split('?')[0]

const chrome = chromeBinary()
const built = builtRendererPresent()
const ready = chrome !== null && built

if (!ready) {
  process.stdout.write(
    `perf: remote-open gate SKIPPED — ${chrome === null ? 'no Chrome (set COOKREW_CHROME)' : `no built renderer at ${rendererDir()} (npm run build)`}\n`
  )
}

// On CI the build step may fail without stopping the job (perf.yml lets the
// other gates run): that must not turn this gate into a green skip.
describe.runIf(process.env.CI === 'true' && chrome !== null && !built)('the remote canvas boot on CI', () => {
  it('has a built renderer to measure', () => {
    expect(built, `no built renderer at ${rendererDir()}: the build step failed`).toBe(true)
  })
})

describe.skipIf(!ready)('the remote canvas boot asks for each thing once', () => {
  let companion: FixtureCompanion
  let profile = ''
  let browser: Awaited<ReturnType<typeof launchChrome>> | null = null
  let cdp: CdpClient | null = null
  const hosts = new Set<string>()
  /** When the PAGE issued each beacon (CDP monotonic ms), before any wait for a connection. */
  const beaconSentAt: number[] = []
  let firstCardAt = 0
  let navigatedAt = 0
  /** When the recording stopped looking, before anything was torn down. */
  let recordedUntil = 0

  beforeAll(async () => {
    companion = await startFixtureCompanion()
    profile = mkdtempSync(path.join(tmpdir(), 'courier-gate-'))
    browser = await launchChrome({ userDataDir: profile })
    cdp = await connectCdp(await pageTarget(browser.port))
    await cdp.send('Network.enable')
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 500, height: 900, deviceScaleFactor: 2, mobile: true })
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER })
    cdp.on('Network.requestWillBeSent', (p) => {
      const request = p.request as { url: string; method?: string }
      const url = String(request.url)
      if (url.startsWith('data:')) return
      try {
        const parsed = new URL(url)
        hosts.add(parsed.host)
        if (request.method === 'POST' && parsed.pathname.endsWith('/api/beacon') && recordedUntil === 0) {
          beaconSentAt.push(Number(p.timestamp) * 1000)
        }
      } catch {
        // Not a URL this can reason about; the fixture's own log has it.
      }
    })
    navigatedAt = Date.now()
    await cdp.send('Page.navigate', { url: `${companion.origin}/?token=fixture-token` })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const reply = await cdp.send('Runtime.evaluate', { expression: 'window.__courier && window.__courier.firstCard', returnByValue: true })
      const value = (reply.result as { value?: unknown } | undefined)?.value
      if (typeof value === 'number') {
        firstCardAt = value
        break
      }
      await sleep(100)
    }
    // The boot window after first card (the activity snapshot seeds, the
    // overview fit settles, any tail read a card was going to make is made:
    // use-stream-tails waits 200 ms), and on past it for several beacon
    // periods: what keeps asking, and whether the streams stay open.
    if (firstCardAt > 0) await sleep(Math.max(0, firstCardAt + RECORD_AFTER_CARD_MS - Date.now()))
    recordedUntil = Date.now()
  })

  afterAll(async () => {
    cdp?.close()
    const child = browser?.child
    if (child) {
      const exited = new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve(undefined)
        child.once('exit', () => resolve(undefined))
        setTimeout(resolve, 3000)
      })
      child.kill('SIGKILL')
      await exited
    }
    // Chrome's helper processes can still be flushing the profile after the
    // browser itself has exited (ENOTEMPTY on the macOS runner, 2026-11-15 and
    // PR #124, with every gate in the file passed). A profile left in tmp is
    // nothing; a teardown that throws fails the gates that just passed.
    try {
      if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
    } catch {
      // leave it to tmp
    }
    await companion?.close()
  })

  /** Every request the recording saw. Throws when there was no card: nothing to claim. */
  const recorded = (): FixtureRequest[] => {
    if (firstCardAt === 0) throw new Error(`no ${FIRST_CARD_SELECTOR} was drawn: the boot window is undefined (see "drew a card")`)
    return companion.requests.filter((r) => r.at <= recordedUntil)
  }
  /** Every request until BOOT_WINDOW_MS after the first card. */
  const windowed = (): FixtureRequest[] => recorded().filter((r) => r.at <= firstCardAt + BOOT_WINDOW_MS)
  const charged = (): FixtureRequest[] => bootCharged(windowed(), (r) => r.path)
  const openings = (pathname: string): FixtureRequest[] => windowed().filter((r) => pathnameOf(r.path) === pathname)

  it('drew a card', () => {
    if (process.env.PERF_DUMP) {
      for (const r of companion.requests) process.stdout.write(`DUMP +${r.at - navigatedAt} ${r.status} ${r.known ? '' : 'UNKNOWN '}${r.method} ${r.path}\n`)
    }
    expect(firstCardAt).toBeGreaterThan(0)
    process.stdout.write(`perf: remote-open first card ${firstCardAt - navigatedAt} ms after navigation (reported, not asserted)\n`)
  })

  // A route the fixture cannot answer is answered 404, and a 404 changes what
  // the boot does next (a retry, a reconnect, a fallback): the count would be
  // the fixture's. A route the boot grew must be modelled before it is counted.
  it('asks for nothing the fixture companion does not answer as the real one does, the whole recording', () => {
    expect(recorded().filter((r) => !r.known).map((r) => `${r.method} ${r.path}`)).toEqual([])
  })

  // The window is time-based; this is what makes it safe to count from. A boot
  // still asking after it (a slower runner, a later chunk) would be counted
  // short and pass: here it fails instead, naming what came late.
  it('finished booting inside its window: no boot request after it', () => {
    const late = recorded().filter((r) => r.at > firstCardAt + BOOT_WINDOW_MS && requestKind(r.path) === 'request')
    expect(late.map((r) => `+${r.at - firstCardAt} ms ${r.method} ${r.path}`)).toEqual([])
  })

  it(`performs at most ${REMOTE_OPEN.maxBootRequests} requests before and around first card`, () => {
    const requests = charged().map((r) => r.path)
    process.stdout.write(`perf: remote-open boot requests ${requests.length}: ${requests.join(' ')}\n`)
    expect(requests.length).toBeLessThanOrEqual(REMOTE_OPEN.maxBootRequests)
    const api = requests.filter((p) => p.startsWith('/api/'))
    expect(api.length).toBeLessThanOrEqual(REMOTE_OPEN.maxBootApiRequests)
    expect(requests.length - api.length).toBeLessThanOrEqual(REMOTE_OPEN.maxBootStaticRequests)
  })

  // By PATH, query dropped: a cache-busting parameter must not make the same
  // read look new. The one path allowed more than once is listed, with its count.
  it('asks for each thing once: no path is asked twice, but the listed log reads', () => {
    const allowed: Record<string, number> = { 'GET /api/events/query': REMOTE_OPEN.maxLogReads }
    const seen = new Map<string, number>()
    for (const r of charged()) {
      const what = `${r.method} ${pathnameOf(r.path)}`
      seen.set(what, (seen.get(what) ?? 0) + 1)
    }
    expect([...seen].filter(([what, n]) => n > (allowed[what] ?? 1)).map(([what, n]) => `${n}x ${what}`)).toEqual([])
  })

  it('fetches the workspace once, and the list once', () => {
    expect(openings('/api/workspace').length).toBeLessThanOrEqual(REMOTE_OPEN.maxWorkspaceFetches)
    expect(openings('/api/workspaces').length).toBeLessThanOrEqual(REMOTE_OPEN.maxWorkspaceListFetches)
  })

  it('watched for several beacon periods past first card', () => {
    recorded() // no card, no claim
    expect(recordedUntil - firstCardAt).toBeGreaterThanOrEqual(3 * BEACON_CLOCK_MS)
  })

  // The whole recording, not only the window: a reconnect loop shows later,
  // and a stream that dropped and was not reopened is still open at the end.
  it('opens the event stream once, booting from the pull, and it is still open at the end', () => {
    const streams = recorded().filter((r) => pathnameOf(r.path) === '/api/events')
    expect(streams).toHaveLength(1)
    expect(streams[0].path).toMatch(/[?&]boot=[a-z0-9-]{8,}/)
    expect(streams[0].closedAt, 'the event stream closed before the recording ended').toBeNull()
  })

  it('opens the fleet stream once, and it is still open at the end', () => {
    const fleet = recorded().filter((r) => pathnameOf(r.path) === '/api/fleet/stream')
    expect(fleet.map((r) => r.status)).toEqual([200])
    expect(fleet[0].closedAt, 'the fleet stream closed before the recording ended').toBeNull()
  })

  it('sends one beacon at boot, and after it only on the beacon clock', () => {
    const beacons = recorded().filter((r) => requestKind(r.path) === 'beacon')
    // Several clock periods were watched: the clock was seen to tick twice, not just the boot's beacon.
    expect(beacons.length).toBeGreaterThanOrEqual(3)
    // The page's own record of sending, which the gaps below are judged on.
    expect(beaconSentAt.length).toBeGreaterThanOrEqual(3)
    // Judged by when the PAGE sent each one, not when it arrived: any beacon can
    // queue for a connection on a slow runner and arrive late, so arrival gaps
    // came in short between clock ticks too (2117 ms after boot on PR #124,
    // 2305 ms between ticks on PR #128). The boot beacon and the clock start
    // together, so from the boot one on every gap is a whole period; a timer
    // runs late, never early, and a second clock or an off-clock beacon lands short.
    const gaps = beaconSentAt.slice(1).map((at, i) => at - beaconSentAt[i])
    expect(gaps.filter((gap) => gap < BEACON_CLOCK_MS * 0.8)).toEqual([])
    // And no more than the clock allows over the recording.
    expect(beacons.length).toBeLessThanOrEqual(2 + Math.floor((recordedUntil - beacons[0].at) / (BEACON_CLOCK_MS * 0.8)))
  })

  it('asks for no git state the payload already carried', () => {
    expect(windowed().filter((r) => r.path.startsWith('/api/git')).length).toBeLessThanOrEqual(REMOTE_OPEN.maxGitFetches)
  })

  it('reads no stream tail before the activity snapshot has landed', () => {
    expect(windowed().filter((r) => /\/stream\/open/.test(r.path)).length).toBeLessThanOrEqual(REMOTE_OPEN.maxTailReadsAtBoot)
  })

  it('talks to nothing off the companion origin', () => {
    windowed() // no card, no claim
    const own = new URL(companion.origin).host
    const others = [...hosts].filter((host) => host !== own)
    expect(others.length).toBeLessThanOrEqual(REMOTE_OPEN.maxThirdPartyRequests)
  })
})
