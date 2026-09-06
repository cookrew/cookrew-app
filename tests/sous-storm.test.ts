import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtySession } from '../src/main/pty'
import { createSousBreaker, SOUS_BREAKER_MAX_IN_FLIGHT, SOUS_BREAKER_THRESHOLD } from '../src/main/sous-breaker'
import type { TurnSummarizer } from '../src/main/sous'
import type { SousReadiness } from '../src/main/sous-breaker'

/**
 * The retry storm, reproduced: Ollama is up but cannot answer inside the
 * timeout (a loaded machine), so every request ends in TimeoutError. The
 * tracker keeps a backfill pump ticking every 2 s and N thinking terminals
 * refreshing their titles every 15 s, all through the REAL sous.ts, with
 * fetch replaced by one that times out on the fake clock exactly the way
 * AbortSignal.timeout would. What is counted is requests: each one holds an
 * Ollama generate slot for the whole timeout and logs a line when it dies.
 */
const TIMEOUT_ERROR = (): DOMException =>
  new DOMException('The operation was aborted due to timeout', 'TimeoutError')

class FakeSession extends EventEmitter {
  full = ''
  idle = 0
  constructor(public terminalId: string) {
    super()
  }
  fullText(): string {
    return this.full
  }
  viewportText(): string {
    return this.full
  }
  idleFor(): number {
    return this.idle
  }
}

interface StormRun {
  requests: number
  minutes: number
  perMinute: number
  logLines: number
}

const OPEN_LINE = /^Sous: (circuit open after|probe failed)/

async function runStorm(terminals: number, untitled: number, minutes: number, timeoutMs: number): Promise<StormRun> {
  let requests = 0
  const fetchStub = vi.fn(
    () =>
      new Promise<Response>((_resolve, reject) => {
        requests += 1
        setTimeout(() => reject(TIMEOUT_ERROR()), timeoutMs)
      })
  )
  vi.stubGlobal('fetch', fetchStub)
  const logLines = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    // The production wiring: the real summarizer and the real readiness.
    const { summarizeTurn, sousReadiness } = await import('../src/main/sous')
    const { TurnTracker } = await import('../src/main/turn-tracker')
    const tracker = new TurnTracker(summarizeTurn, null, undefined, sousReadiness)
    const sessions = Array.from({ length: terminals }, (_, i) => new FakeSession(`term-${i}`))
    for (const session of sessions) tracker.track(session as unknown as PtySession, true)
    tracker.replaceHistory(
      'term-0',
      Array.from({ length: untitled }, (_, i) => ({
        index: i + 1,
        prompt: `task ${i}`,
        reply: `done ${i}`,
        uuid: `u${i}`,
        startedAt: i,
        endedAt: i + 1
      }))
    )
    for (const session of sessions) session.emit('input', 'keep going\r')
    await vi.advanceTimersByTimeAsync(minutes * 60_000)
    tracker.disposeAll()
    const lines = logLines.mock.calls.filter((c) => OPEN_LINE.test(String(c[0]))).length
    return { requests, minutes, perMinute: requests / minutes, logLines: lines }
  } finally {
    logLines.mockRestore()
    vi.unstubAllGlobals()
  }
}

describe('Sous under a permanent timeout', () => {
  beforeEach(() => {
    // sous.ts holds the process-wide breaker: every test gets a closed one.
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // Before the breaker (2026-09-06, same harness): 147 requests in 10 min =
  // 14.70/min, 126 Sous log lines. After: two in flight die together, two
  // more are admitted and die together (the third failure opens the
  // breaker, the fourth was already in flight), then one probe per widening
  // window — 30 s and 2 min end inside the run, 10 min does not: six
  // requests in ten minutes, and one line per open.
  it('the owner shape — 20 thinking terminals, 10 untitled records, 30 s cold timeout — makes K+3 requests in 10 minutes', async () => {
    const run = await runStorm(20, 10, 10, 30_000)
    process.stdout.write(
      `sous storm: ${run.requests} requests in ${run.minutes} min = ${run.perMinute.toFixed(2)}/min, ${run.logLines} Sous log lines\n`
    )
    expect(run.requests).toBeLessThanOrEqual(SOUS_BREAKER_THRESHOLD + SOUS_BREAKER_MAX_IN_FLIGHT + 1)
    expect(run.perMinute).toBeLessThan(1)
    // One line per open, none per attempt: 30 s, 2 min, 10 min = three opens.
    expect(run.logLines).toBe(3)
  }, 180_000)

  // The structural bound Atlas asked for, on the pump alone: K failures open
  // the breaker, one probe follows when the 30 s window ends, and the 2 min
  // window outlasts the run.
  it('60 backfill ticks against a permanently timing-out summarizer perform at most K+1 requests', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const breaker = createSousBreaker({ log: () => undefined })
    const timingOut: TurnSummarizer = () =>
      breaker.guard(
        () =>
          new Promise((_resolve, reject) => {
            attempts += 1
            setTimeout(() => reject(TIMEOUT_ERROR()), 8000)
          })
      )
    const { TurnTracker } = await import('../src/main/turn-tracker')
    const tracker = new TurnTracker(timingOut, null, undefined, () => breaker.readiness())
    const session = new FakeSession('term-0')
    tracker.track(session as unknown as PtySession, true)
    tracker.replaceHistory(
      'term-0',
      Array.from({ length: 30 }, (_, i) => ({
        index: i + 1,
        prompt: `task ${i}`,
        reply: `done ${i}`,
        uuid: `u${i}`,
        startedAt: i,
        endedAt: i + 1
      }))
    )
    await vi.advanceTimersByTimeAsync(60 * 2000)
    tracker.disposeAll()
    expect(attempts).toBeLessThanOrEqual(SOUS_BREAKER_THRESHOLD + 1)
    expect(breaker.state().state).toBe('open')
    expect(tracker.history('term-0').every((r) => r.title === undefined)).toBe(true)
  })

  it('the record that just failed is not the next tick\'s pick, and its cooldown doubles', async () => {
    vi.useFakeTimers()
    const asked: string[] = []
    const failing: TurnSummarizer = async (input) => {
      asked.push(input.prompt)
      return null
    }
    const { TurnTracker } = await import('../src/main/turn-tracker')
    const tracker = new TurnTracker(failing, null, undefined, () => 'ready')
    const session = new FakeSession('term-0')
    tracker.track(session as unknown as PtySession, true)
    tracker.replaceHistory('term-0', [
      { index: 1, prompt: 'a', reply: 'r', uuid: 'u1', startedAt: 1, endedAt: 2 },
      { index: 2, prompt: 'b', reply: 'r', uuid: 'u2', startedAt: 3, endedAt: 4 }
    ])
    await vi.advanceTimersByTimeAsync(2000 * 3)
    expect(asked).toEqual(['a', 'b']) // a failed, so the next tick picked b
    await vi.advanceTimersByTimeAsync(60_000)
    expect(asked).toEqual(['a', 'b', 'a', 'b']) // both retried after 60 s
    await vi.advanceTimersByTimeAsync(60_000)
    expect(asked).toEqual(['a', 'b', 'a', 'b']) // the second wait is 2 min
    await vi.advanceTimersByTimeAsync(62_000)
    expect(asked).toEqual(['a', 'b', 'a', 'b', 'a', 'b'])
    tracker.disposeAll()
  })

  it('while the breaker is open the tracker makes no call, spends no cooldown, and keeps its title cadence', async () => {
    vi.useFakeTimers()
    let readiness: SousReadiness = 'open'
    const summarize = vi.fn(async () => 'Titled')
    const { TurnTracker } = await import('../src/main/turn-tracker')
    const tracker = new TurnTracker(summarize, null, undefined, () => readiness)
    const session = new FakeSession('term-0')
    tracker.track(session as unknown as PtySession, true)
    tracker.replaceHistory('term-0', [{ index: 1, prompt: 'a', reply: 'r', uuid: 'u1', startedAt: 1, endedAt: 2 }])
    session.emit('input', 'work\r') // a thinking terminal: refreshTitle every 15 s
    await vi.advanceTimersByTimeAsync(60_000)
    expect(summarize).not.toHaveBeenCalled() // neither the pump nor the refresh
    readiness = 'ready'
    // The pump picks the record on the very next tick: its cooldown was never spent.
    await vi.advanceTimersByTimeAsync(2000)
    expect(summarize).toHaveBeenCalled()
    expect(tracker.history('term-0')[0].title).toBe('Titled')
    // The refresh cadence survived the open window: a title lands within one period.
    summarize.mockClear()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(summarize.mock.calls.length).toBeGreaterThan(0)
    expect(tracker.list()[0].title).toBe('Titled')
    tracker.disposeAll()
  })

  it('a busy summarizer makes the refresh come back in a moment, not in fifteen seconds', async () => {
    vi.useFakeTimers()
    let readiness: SousReadiness = 'busy'
    const summarize = vi.fn(async () => 'Titled')
    const { TurnTracker } = await import('../src/main/turn-tracker')
    const tracker = new TurnTracker(summarize, null, undefined, () => readiness)
    const session = new FakeSession('term-0')
    tracker.track(session as unknown as PtySession, true)
    session.emit('input', 'work\r')
    await vi.advanceTimersByTimeAsync(1000) // past TITLE_FIRST_MS, found busy
    readiness = 'ready'
    await vi.advanceTimersByTimeAsync(2000)
    expect(summarize).toHaveBeenCalledTimes(1)
    tracker.disposeAll()
  })

  it('a title that failed still backfills once the summarizer answers', async () => {
    vi.useFakeTimers()
    let answer: string | null = null
    const { TurnTracker } = await import('../src/main/turn-tracker')
    const tracker = new TurnTracker(async () => answer, null, undefined, () => 'ready')
    const session = new FakeSession('term-0')
    tracker.track(session as unknown as PtySession, true)
    tracker.replaceHistory('term-0', [{ index: 1, prompt: 'a', reply: 'r', uuid: 'u1', startedAt: 1, endedAt: 2 }])
    await vi.advanceTimersByTimeAsync(2000 * 2)
    expect(tracker.history('term-0')[0].title).toBeUndefined()
    answer = 'Titled late'
    await vi.advanceTimersByTimeAsync(62_000)
    expect(tracker.history('term-0')[0].title).toBe('Titled late')
    tracker.disposeAll()
  })
})
