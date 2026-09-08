import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromeBinary, connectCdp, launchChrome, pageTarget, type CdpClient } from '../../scripts/perf-cdp.mjs'
import { REMOTE_OPEN } from './budgets'
import { builtRendererPresent, rendererDir, startFixtureCompanion, type FixtureCompanion } from './remote-open-fixture'

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
 * Skips, loudly, without Chrome or without out/renderer (CI builds first).
 */

const OBSERVER = `(() => {
  const marks = { firstCard: null }
  window.__courier = marks
  const seen = () => {
    if (marks.firstCard === null && document.querySelector('.react-flow__node')) {
      marks.firstCard = Date.now()
      observer.disconnect()
    }
  }
  const observer = new MutationObserver(seen)
  document.addEventListener('DOMContentLoaded', () => { observer.observe(document.documentElement, { childList: true, subtree: true }); seen() })
})()`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const isStream = (p: string): boolean => /^\/api\/events(\?|$)|\/api\/terminal\/[^/]+\/stream(\?|$)/.test(p)
const isThumb = (p: string): boolean => /\/api\/browser\/[^/]+\/thumb|\/api\/browser\/thumbs/.test(p)

const chrome = chromeBinary()
const built = builtRendererPresent()
const ready = chrome !== null && built

if (!ready) {
  process.stdout.write(
    `perf: remote-open gate SKIPPED — ${chrome === null ? 'no Chrome (set COOKREW_CHROME)' : `no built renderer at ${rendererDir()} (npm run build)`}\n`
  )
}

describe.skipIf(!ready)('the remote canvas boot asks for each thing once', () => {
  let companion: FixtureCompanion
  let profile = ''
  let browser: Awaited<ReturnType<typeof launchChrome>> | null = null
  let cdp: CdpClient | null = null
  const hosts = new Set<string>()
  let firstCardAt = 0
  let navigatedAt = 0

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
      const url = String((p.request as { url: string }).url)
      if (url.startsWith('data:')) return
      try {
        hosts.add(new URL(url).host)
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
    // The window after first card: the activity snapshot seeds, the overview
    // fit settles, and any tail read a card was going to make would have
    // been made (use-stream-tails waits 200 ms).
    await sleep(2_000)
  })

  afterAll(async () => {
    cdp?.close()
    browser?.child.kill('SIGKILL')
    if (profile) rmSync(profile, { recursive: true, force: true })
    await companion?.close()
  })

  const boot = (): string[] => {
    const until = firstCardAt + 2_000
    return companion.requests.filter((r) => r.at <= until).map((r) => r.path)
  }

  it('drew a card', () => {
    expect(firstCardAt).toBeGreaterThan(0)
    process.stdout.write(`perf: remote-open first card ${firstCardAt - navigatedAt} ms after navigation (reported, not asserted)\n`)
  })

  it(`performs at most ${REMOTE_OPEN.maxBootRequests} requests before and around first card`, () => {
    const requests = boot().filter((p) => !isStream(p) && !isThumb(p))
    process.stdout.write(`perf: remote-open boot requests ${requests.length}: ${requests.join(' ')}\n`)
    expect(requests.length).toBeLessThanOrEqual(REMOTE_OPEN.maxBootRequests)
  })

  it('fetches the workspace once, and the list once', () => {
    const paths = boot()
    expect(paths.filter((p) => p === '/api/workspace' || p.startsWith('/api/workspace?')).length).toBeLessThanOrEqual(REMOTE_OPEN.maxWorkspaceFetches)
    expect(paths.filter((p) => p === '/api/workspaces' || p.startsWith('/api/workspaces?')).length).toBeLessThanOrEqual(REMOTE_OPEN.maxWorkspaceListFetches)
  })

  it('opens the event stream once, booting from the pull', () => {
    const streams = boot().filter((p) => p.startsWith('/api/events'))
    expect(streams).toHaveLength(1)
    expect(streams[0]).toContain('boot=pull')
  })

  it('asks for no git state the payload already carried', () => {
    expect(boot().filter((p) => p.startsWith('/api/git')).length).toBeLessThanOrEqual(REMOTE_OPEN.maxGitFetches)
  })

  it('reads no stream tail before the activity snapshot has landed', () => {
    expect(boot().filter((p) => /\/stream\/open/.test(p)).length).toBeLessThanOrEqual(REMOTE_OPEN.maxTailReadsAtBoot)
  })

  it('talks to nothing off the companion origin', () => {
    const own = new URL(companion.origin).host
    const others = [...hosts].filter((host) => host !== own)
    expect(others.length).toBeLessThanOrEqual(REMOTE_OPEN.maxThirdPartyRequests)
  })
})
