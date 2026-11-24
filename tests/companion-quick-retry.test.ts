// A KNOCK ANSWERED BY SILENCE IS TRIED AGAIN IN SECONDS, ON THE REAL CLOCK.
//
// 0.6.37 (path/rtc-trust.ts · knockGapAfter) shortened the gap after a knock
// nothing answered to RTC_QUICK_MS, up to RTC_QUICK_TRIES in a row. But the gap
// only says when a knock MAY go: a knock goes when a race runs, and nothing
// runs a race at that moment. The race loop (path/race-loop.ts) ticks every
// RACE_EVERY_MS, so the "15 s" retry still waits for the next minute's tick.
//
// These run the real companion on the real race loop under fake timers, with
// the dial (connectRtcLink) counted and answered by nothing, and ask when the
// knocks actually go out. No push, no `online`, no tab change: the clock alone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RACE_EVERY_MS } from '../src/renderer/src/path/race-loop'
import { RTC_EVERY_MS, RTC_QUICK_MS, RTC_QUICK_TRIES, RTC_REFUSED_EVERY_MS } from '../src/renderer/src/path/rtc-trust'
import { inConsole, unfoldRelay } from './support/console-scope'

const DEVICE = '11111111-2222-3333-4444-555555555555'

/**
 * How late a quick retry may go past RTC_QUICK_MS and still be "after the gap".
 * A schedule built on the gap plus a short settle (as RACE_AFTER_END_MS is for
 * an ended link) fits; one that waits for the minute's tick does not.
 */
const QUICK_SLACK_MS = 1_000

/** A phone on the relay with a live event stream, its path reports kept. */
const stubPhone = (): { readonly reports: () => number } => {
  let reports = 0
  vi.doMock('../src/renderer/src/path/report', async (original) => ({
    ...(await original<typeof import('../src/renderer/src/path/report')>()),
    postPathReport: async () => void (reports += 1)
  }))
  class FakeEventSource {
    readyState = 1
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {
      this.readyState = 2
    }
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    COOKREW_MOBILE: 1,
    location: { origin: 'https://cookrew.dev', search: '', hash: '', replace: () => undefined, assign: () => undefined },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    history: { replaceState: () => undefined },
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined
  }
  // A page in front: a retry that waits for the page to be visible may go.
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined })
  Object.assign(globalThis, { EventSource: FakeEventSource })
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (unfoldRelay(String(url), init).includes('/api/events')) {
      return new Response(new ReadableStream(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error('unreachable')
  }
  return { reports: () => reports }
}

/**
 * Every knock, with the (fake) time it was dialled. `refusal` null is silence:
 * no answer at all, which is what earns the quick gap.
 */
const recordKnocks = (refusal: string | null = null): { readonly times: () => readonly number[] } => {
  const times: number[] = []
  vi.doMock('../src/renderer/src/path/rtc-link', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/renderer/src/path/rtc-link')>()),
    connectRtcLink: async (deps: { refused?: (why: string) => void }) => {
      times.push(Date.now())
      if (refusal !== null) deps.refused?.(refusal)
      return null
    }
  }))
  vi.stubGlobal('RTCPeerConnection', function RTCPeerConnection() {})
  return { times: () => times }
}

/**
 * Let work that no fake timer drives (the Ed25519 probe, the stream's fetch)
 * finish: real turns of the event loop until `done`, or a short real deadline.
 */
const drain = async (done: () => boolean = () => false, realMs = 300): Promise<void> => {
  const deadline = performance.now() + realMs
  while (!done() && performance.now() < deadline) await new Promise((resolve) => setImmediate(resolve))
}

/** Move the fake clock to `at` (ms since epoch), then let what that started finish. */
const advanceTo = async (at: number, done?: () => boolean): Promise<void> => {
  const by = at - Date.now()
  if (by > 0) await vi.advanceTimersByTimeAsync(by)
  await drain(done)
}

/** The real companion on machine DEVICE, under a fake clock, its boot knock out and reported. */
const boot = async (refusal: string | null = null) => {
  const phone = stubPhone()
  vi.resetModules()
  const { times } = recordKnocks(refusal)
  await inConsole(DEVICE)
  const companion = await import('../src/renderer/src/path/companion')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  const stop = companion.startCompanionPathSwitch()
  await drain(() => times().length >= 1 && phone.reports() >= 1, 5_000)
  expect(times()).toHaveLength(1)
  return { times, stop }
}

let stops: (() => void)[] = []
beforeEach(() => {
  stops = []
})

afterEach(() => {
  stops.forEach((stop) => stop())
  vi.useRealTimers()
  delete (globalThis as { fetch?: unknown }).fetch
  delete (globalThis as { EventSource?: unknown }).EventSource
  vi.doUnmock('../src/renderer/src/path/rtc-link')
  vi.doUnmock('../src/renderer/src/path/report')
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('a knock answered by silence (0.6.37 · RTC_QUICK_MS)', () => {
  it('is knocked again RTC_QUICK_MS later on the clock alone, not at the next minute\'s race', async () => {
    const run = await boot()
    stops.push(run.stop)
    const [first] = run.times()

    // The gap holds: nothing goes before it is up.
    await advanceTo(first + RTC_QUICK_MS - 1)
    expect(run.times()).toHaveLength(1)

    // And something goes once it is: well before the loop's own tick.
    expect(RTC_QUICK_MS + QUICK_SLACK_MS).toBeLessThan(RACE_EVERY_MS)
    await advanceTo(first + RTC_QUICK_MS + QUICK_SLACK_MS, () => run.times().length >= 2)
    expect(run.times(), `second knock should go within ${RTC_QUICK_MS + QUICK_SLACK_MS} ms of the first`).toHaveLength(2)
    expect(run.times()[1] - first).toBeGreaterThanOrEqual(RTC_QUICK_MS)
  })

  it(`is retried quickly ${RTC_QUICK_TRIES - 1} more times, then waits the full RTC_EVERY_MS`, async () => {
    const run = await boot()
    stops.push(run.stop)

    // RTC_QUICK_TRIES knocks in all, each one quick gap after the last.
    for (let knock = 2; knock <= RTC_QUICK_TRIES; knock += 1) {
      const last = run.times()[knock - 2]
      await advanceTo(last + RTC_QUICK_MS + QUICK_SLACK_MS, () => run.times().length >= knock)
      expect(run.times(), `knock ${knock} should go within ${RTC_QUICK_MS + QUICK_SLACK_MS} ms of knock ${knock - 1}`).toHaveLength(knock)
      expect(run.times()[knock - 1] - last).toBeGreaterThanOrEqual(RTC_QUICK_MS)
    }

    // The quick tries are spent: the next knock holds for the whole gap.
    const lastQuick = run.times()[RTC_QUICK_TRIES - 1]
    await advanceTo(lastQuick + RTC_EVERY_MS - 1)
    expect(run.times()).toHaveLength(RTC_QUICK_TRIES)
  })
})

describe('what the quick retry must not change', () => {
  it('the minute\'s race still knocks after silence (the control: this fake clock drives the real loop)', async () => {
    const run = await boot()
    stops.push(run.stop)
    const [first] = run.times()

    await advanceTo(first + RACE_EVERY_MS + QUICK_SLACK_MS, () => run.times().length >= 2)
    expect(run.times().length).toBeGreaterThanOrEqual(2)
  })

  it('a refused answer still waits RTC_REFUSED_EVERY_MS, however the clock runs', async () => {
    const run = await boot('no binding')
    stops.push(run.stop)
    const [first] = run.times()

    await advanceTo(first + RTC_QUICK_MS + QUICK_SLACK_MS)
    expect(run.times()).toHaveLength(1)
    await advanceTo(first + RTC_REFUSED_EVERY_MS - 1)
    expect(run.times()).toHaveLength(1)
  })

  it('a stopped companion leaves no retry behind', async () => {
    const run = await boot()
    const [first] = run.times()
    run.stop()
    expect(vi.getTimerCount(), 'the retry timer is cleared immediately').toBe(0)

    await advanceTo(first + RTC_QUICK_MS + QUICK_SLACK_MS)
    await advanceTo(first + RACE_EVERY_MS + QUICK_SLACK_MS)
    expect(run.times()).toHaveLength(1)
    expect(vi.getTimerCount(), 'no timer of the companion\'s outlives stop()').toBe(0)
  })
})
