import { describe, expect, it } from 'vitest'
import { createSousBreaker, formatDuration, isNetworkError, redactReason, type SousAttempt } from '../src/main/sous-breaker'

/**
 * The breaker in front of Sous: K consecutive failures open it for a
 * widening window (30 s, 2 min, 10 min, 30 min cap), one probe per window,
 * one success closes it, one log line per open and per close, and never a
 * request or a line while it is open.
 */
function harness(over: { threshold?: number; maxInFlight?: number } = {}) {
  let clock = 1_000_000
  const lines: string[] = []
  const breaker = createSousBreaker({ now: () => clock, log: (line) => lines.push(line), ...over })
  let attempts = 0
  const fail = async (): Promise<SousAttempt<string>> => {
    attempts += 1
    return { ok: false, reason: 'TimeoutError: The operation was aborted due to timeout' }
  }
  const succeed = async (): Promise<SousAttempt<string>> => {
    attempts += 1
    return { ok: true, value: 'Fixing the login bug' }
  }
  const throwing = async (): Promise<SousAttempt<string>> => {
    attempts += 1
    const error = new TypeError('fetch failed')
    ;(error as { cause?: unknown }).cause = { code: 'ECONNREFUSED' }
    throw error
  }
  return {
    breaker,
    lines,
    fail,
    succeed,
    throwing,
    attempts: () => attempts,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

describe('Sous circuit breaker', () => {
  it('opens after K consecutive failures and refuses without a request or a line while open', async () => {
    const h = harness()
    for (let i = 0; i < 3; i += 1) expect(await h.breaker.guard(h.fail)).toBeNull()
    expect(h.attempts()).toBe(3)
    expect(h.breaker.state().state).toBe('open')
    expect(h.breaker.state().windowMs).toBe(30_000)
    expect(h.lines).toHaveLength(1)
    expect(h.lines[0]).toMatch(/^Sous: circuit open after 3 consecutive failures \(TimeoutError.*\); no title requests for 30s$/)
    for (let i = 0; i < 50; i += 1) {
      h.advance(500)
      expect(h.breaker.readiness()).toBe('open')
      expect(await h.breaker.guard(h.fail)).toBeNull()
    }
    expect(h.attempts()).toBe(3)
    expect(h.breaker.state().refused).toBe(50)
    expect(h.lines).toHaveLength(1)
  })

  it('does not open on fewer than K failures, and a success resets the count', async () => {
    const h = harness()
    await h.breaker.guard(h.fail)
    await h.breaker.guard(h.fail)
    await h.breaker.guard(h.succeed)
    await h.breaker.guard(h.fail)
    await h.breaker.guard(h.fail)
    expect(h.breaker.state().state).toBe('closed')
    expect(h.breaker.state().consecutiveFailures).toBe(2)
    expect(h.lines).toEqual([])
  })

  it('widens per failed probe: 30 s, 2 min, 10 min, then 30 min for good', async () => {
    const h = harness()
    for (let i = 0; i < 3; i += 1) await h.breaker.guard(h.fail)
    const seen: number[] = [h.breaker.state().windowMs!]
    for (let probe = 0; probe < 5; probe += 1) {
      h.advance(h.breaker.state().windowMs! - 1)
      expect(h.breaker.readiness()).toBe('open')
      h.advance(1)
      expect(h.breaker.readiness()).toBe('ready')
      expect(await h.breaker.guard(h.fail)).toBeNull() // the one probe
      seen.push(h.breaker.state().windowMs!)
    }
    expect(seen).toEqual([30_000, 120_000, 600_000, 1_800_000, 1_800_000, 1_800_000])
    expect(h.attempts()).toBe(3 + 5)
    expect(h.breaker.state().trips).toBe(6)
    expect(h.lines).toHaveLength(6)
    expect(h.lines[5]).toBe('Sous: probe failed (TimeoutError: The operation was aborted due to timeout); circuit stays open for 30m')
  })

  it('admits exactly one probe per window: a second caller in the same window is refused', async () => {
    const h = harness()
    for (let i = 0; i < 3; i += 1) await h.breaker.guard(h.fail)
    h.advance(30_000)
    let release: (() => void) | null = null
    const slow = (): Promise<SousAttempt<string>> =>
      new Promise((resolve) => {
        release = () => resolve({ ok: false, reason: 'TimeoutError: slow' })
      })
    const probe = h.breaker.guard(slow)
    expect(h.breaker.state().state).toBe('half-open')
    expect(h.breaker.readiness()).toBe('open')
    expect(await h.breaker.guard(h.fail)).toBeNull()
    expect(h.attempts()).toBe(3) // the second caller made no request
    release!()
    await probe
    expect(h.breaker.state().state).toBe('open')
    expect(h.breaker.state().windowMs).toBe(120_000)
  })

  it('closes on a single successful probe, resets the ladder, and logs one line', async () => {
    const h = harness()
    for (let i = 0; i < 3; i += 1) await h.breaker.guard(h.fail)
    h.advance(30_000)
    await h.breaker.guard(h.fail) // 2 min
    h.advance(120_000)
    expect(await h.breaker.guard(h.succeed)).toBe('Fixing the login bug')
    const state = h.breaker.state()
    expect(state.state).toBe('closed')
    expect(state.consecutiveFailures).toBe(0)
    expect(state.openUntil).toBeNull()
    expect(h.lines).toHaveLength(3)
    expect(h.lines[2]).toBe('Sous: circuit closed after 2m 30s; titles resume')
    // The ladder is reset: the next trip starts at 30 s again.
    for (let i = 0; i < 3; i += 1) await h.breaker.guard(h.fail)
    expect(h.breaker.state().windowMs).toBe(30_000)
  })

  it('counts a thrown fetch error with its cause, and caps requests in flight while closed', async () => {
    const h = harness({ maxInFlight: 2 })
    const pending: Array<() => void> = []
    const hang = (): Promise<SousAttempt<string>> =>
      new Promise((resolve) => {
        pending.push(() => resolve({ ok: false, reason: 'TimeoutError' }))
      })
    const a = h.breaker.guard(hang)
    const b = h.breaker.guard(hang)
    expect(h.breaker.state().inFlight).toBe(2)
    expect(h.breaker.readiness()).toBe('busy')
    expect(await h.breaker.guard(h.fail)).toBeNull()
    expect(h.attempts()).toBe(0)
    expect(h.breaker.state().refused).toBe(1)
    for (const done of pending) done()
    await Promise.all([a, b])
    expect(h.breaker.state().inFlight).toBe(0)
    await h.breaker.guard(h.throwing)
    expect(h.breaker.state().state).toBe('open')
    expect(h.breaker.state().lastFailure).toBe('TypeError: fetch failed (ECONNREFUSED)')
    expect(h.lines[0]).toContain('(TypeError: fetch failed (ECONNREFUSED))')
  })

  it('a request that was in flight when the breaker opened neither re-opens nor widens it', async () => {
    const h = harness({ maxInFlight: 5 })
    const pending: Array<() => void> = []
    const hang = (): Promise<SousAttempt<string>> =>
      new Promise((resolve) => {
        pending.push(() => resolve({ ok: false, reason: 'TimeoutError' }))
      })
    const all = [1, 2, 3, 4, 5].map(() => h.breaker.guard(hang))
    for (const done of pending) done()
    await Promise.all(all)
    expect(h.breaker.state().trips).toBe(1)
    expect(h.breaker.state().windowMs).toBe(30_000)
    // The two stragglers adjusted the in-flight count and nothing else.
    expect(h.breaker.state().consecutiveFailures).toBe(3)
    expect(h.breaker.state().inFlight).toBe(0)
    expect(h.lines).toHaveLength(1)
  })

  it('a straggler admitted before the trip decides nothing: not the ladder, not a close', async () => {
    const h = harness({ maxInFlight: 2 })
    const pending: Array<(outcome: SousAttempt<string>) => void> = []
    const hang = (): Promise<SousAttempt<string>> =>
      new Promise((resolve) => {
        pending.push(resolve)
      })
    // A and B fail together; C and D are admitted; C's failure trips the
    // breaker while D is still in flight.
    await h.breaker.guard(h.fail)
    await h.breaker.guard(h.fail)
    const c = h.breaker.guard(hang)
    const d = h.breaker.guard(hang)
    pending[0]({ ok: false, reason: 'TimeoutError' })
    await c
    expect(h.breaker.state().state).toBe('open')
    // The window ends, the probe E goes out; only then does D land.
    h.advance(30_000)
    const e = h.breaker.guard(hang)
    expect(h.breaker.state().state).toBe('half-open')
    pending[1]({ ok: false, reason: 'TimeoutError' })
    await d
    expect(h.breaker.state().state).toBe('half-open') // D did not widen the window
    expect(h.breaker.state().windowMs).toBe(30_000)
    pending[2]({ ok: false, reason: 'TimeoutError' })
    await e
    expect(h.breaker.state().windowMs).toBe(120_000) // E, the real probe, did
    // Same shape with a straggler SUCCESS: it must not close the breaker.
    h.advance(120_000)
    const probe = h.breaker.guard(hang)
    await h.breaker.guard(h.succeed) // refused: half-open admits one
    expect(h.breaker.state().state).toBe('half-open')
    pending[3]({ ok: true, value: 'late' })
    await probe
    expect(h.breaker.state().state).toBe('closed')
    expect(h.lines.filter((l) => l.startsWith('Sous: circuit closed'))).toHaveLength(1)
  })

  it('a pre-trip success landing after the trip does not close it', async () => {
    const h = harness({ maxInFlight: 5 })
    const pending: Array<(outcome: SousAttempt<string>) => void> = []
    const hang = (): Promise<SousAttempt<string>> =>
      new Promise((resolve) => {
        pending.push(resolve)
      })
    const runs = [1, 2, 3, 4].map(() => h.breaker.guard(hang))
    for (let i = 0; i < 3; i += 1) pending[i]({ ok: false, reason: 'TimeoutError' })
    await Promise.all(runs.slice(0, 3))
    expect(h.breaker.state().state).toBe('open')
    pending[3]({ ok: true, value: 'answered at 28s' })
    await runs[3]
    expect(h.breaker.state().state).toBe('open')
    expect(h.breaker.state().lastSuccessAt).not.toBeNull()
    expect(h.lines).toHaveLength(1)
  })

  it('a half-open probe that never settles stops blocking after the probe timeout', async () => {
    const h = harness()
    for (let i = 0; i < 3; i += 1) await h.breaker.guard(h.fail)
    h.advance(30_000)
    void h.breaker.guard(() => new Promise(() => undefined)) // never settles
    expect(h.breaker.readiness()).toBe('open')
    h.advance(60_000 - 1)
    expect(h.breaker.readiness()).toBe('open')
    h.advance(1)
    expect(h.breaker.readiness()).toBe('ready')
    expect(await h.breaker.guard(h.succeed)).toBe('Fixing the login bug')
    expect(h.breaker.state().state).toBe('closed')
  })

  it('never keeps a URL or a credential in the failure it records', async () => {
    const h = harness()
    const leaky = async (): Promise<SousAttempt<string>> => {
      const error = new TypeError('fetch failed: http://user:s3cr3t@ollama.internal:11434/api/generate')
      ;(error as { cause?: unknown }).cause = { code: 'ECONNREFUSED' }
      throw error
    }
    for (let i = 0; i < 3; i += 1) await h.breaker.guard(leaky)
    const recorded = JSON.stringify(h.breaker.state())
    expect(recorded).not.toContain('s3cr3t')
    expect(recorded).not.toContain('ollama.internal')
    expect(h.lines.join('\n')).not.toContain('s3cr3t')
    expect(h.breaker.state().lastFailure).toBe('TypeError: fetch failed: <url> (ECONNREFUSED)')
    expect(redactReason('x'.repeat(500))).toHaveLength(160)
    expect(redactReason('at //user:pw@host/x')).toBe('at //<redacted>@host/x')
    expect(redactReason('connect ECONNREFUSED 127.0.0.1:11434')).toBe('connect ECONNREFUSED <host>')
    expect(redactReason('ollama.internal:11434 refused')).toBe('<host> refused')
    expect(redactReason('Ollama returned 404 for model qwen2.5:1.5b')).toBe('Ollama returned 404 for model qwen2.5:1.5b')
  })

  it('a programming error rethrows to the caller and leaves the breaker as it was', async () => {
    const h = harness()
    const bug = async (): Promise<SousAttempt<string>> => {
      throw new TypeError("Cannot read properties of undefined (reading 'join')")
    }
    for (let i = 0; i < 5; i += 1) await expect(h.breaker.guard(bug)).rejects.toThrow(/reading 'join'/)
    const state = h.breaker.state()
    expect(state.state).toBe('closed')
    expect(state.consecutiveFailures).toBe(0)
    expect(state.inFlight).toBe(0)
    expect(state.lastFailure).toBeNull()
    expect(h.lines).toEqual([])
    // The server's failures still count.
    expect(isNetworkError(new DOMException('aborted', 'TimeoutError'))).toBe(true)
    const refused = new TypeError('fetch failed')
    ;(refused as { cause?: unknown }).cause = { code: 'ECONNREFUSED' }
    expect(isNetworkError(refused)).toBe(true)
    expect(isNetworkError(new TypeError('fetch failed'))).toBe(true)
    expect(isNetworkError(new RangeError('Invalid array length'))).toBe(false)
    expect(isNetworkError('boom')).toBe(false)
  })

  it('formats windows the way the log line reads them', () => {
    expect(formatDuration(30_000)).toBe('30s')
    expect(formatDuration(120_000)).toBe('2m')
    expect(formatDuration(150_000)).toBe('2m 30s')
    expect(formatDuration(1_800_000)).toBe('30m')
  })
})
