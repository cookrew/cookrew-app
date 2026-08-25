// "herdr: lost connection to server: Resource temporarily unavailable
// (os error 35)" — shown by a live agent pane during a workspace switch.
//
// os error 35 is EAGAIN. The long-lived `herdr agent attach` clients stream
// through the same socket that every synchronous herdr CLI call connects to,
// and the multiplexer's settle loops probed that socket by SPAWNING THE CLI in
// a tight `while (Date.now() < deadline)` with nothing between iterations.
//
// Measured against the running server: ~9ms per `herdr agent get`. So the 1s
// registration budget fired ~110 spawns, the 2s budgets ~220 each, and the 12s
// boot-verify budget up to ~1300 — per terminal, and a workspace switch boots
// every terminal on the incoming canvas. With backoff the 12s case is ~120.
//
// Note what this does NOT claim: that the storm is a PROVEN cause of the
// EAGAIN. Proving that would mean deliberately stressing the herdr server the
// whole live fleet depends on. What is proven here is that the storm was real
// and is now bounded.

import { describe, expect, it } from 'vitest'
import { HerdrHostMultiplexer, sleepSync } from '../src/main/herdr-host-multiplexer'
import type { CommandRunner } from '../src/main/multiplexer'

const PANE_LIST = JSON.stringify({
  id: 'cli:pane:list',
  result: { type: 'pane_list', panes: [{ pane_id: 'w1:p1', label: 'cookrew_abc' }] }
})

/** Resolves panes, but NEVER resolves an agent — so the settle loop runs out. */
function unresolvableRunner(calls: string[][]): CommandRunner {
  const answer = (args: string[]): string => {
    calls.push(args)
    if (args[0] === 'pane' && args[1] === 'list') return PANE_LIST
    if (args[0] === 'agent' && args[1] === 'get') throw new Error('agent_not_found')
    return JSON.stringify({ id: 'cli:ok', result: {} })
  }
  return {
    run: (_file, args) => answer(args),
    runQuiet: (_file, args) => {
      calls.push(args)
    },
    probe: (_file, args) => {
      calls.push(args)
      return true
    }
  }
}

describe('sleepSync — a real synchronous wait, not a spin', () => {
  it('actually waits', () => {
    const started = Date.now()
    sleepSync(40)
    // Atomics.wait can return marginally early; the point is that it waits at
    // all, and that it does so without burning the thread.
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
  })

  it('is a no-op for a non-positive gap', () => {
    const started = Date.now()
    sleepSync(0)
    expect(Date.now() - started).toBeLessThan(20)
  })
})

describe('the registration settle loop is throttled, not spun', () => {
  const attachOnce = (): { probes: number; sleeps: number[] } => {
    const calls: string[][] = []
    const sleeps: number[] = []
    const mux = new HerdrHostMultiplexer({
      session: 'cookrewtest',
      configPath: '/c',
      runner: unresolvableRunner(calls),
      startServer: () => undefined,
      waitForServerMs: 0,
      // A short budget so the test does not sit for the real 2s grace.
      settleMs: 60,
      sleep: (ms) => sleeps.push(ms)
    })
    try {
      mux.attachSpawn({ sessionName: 'cookrew_abc', command: 'claude' } as never)
    } catch {
      // The attach may still refuse at the end; the loop before it is the subject.
    }
    const probes = calls.filter((a) => a[0] === 'agent' && a[1] === 'get').length
    return { probes, sleeps }
  }

  it('sleeps between every probe once the loop is entered', () => {
    const { probes, sleeps } = attachOnce()
    expect(probes).toBeGreaterThan(1) // the loop really ran
    expect(sleeps.length).toBeGreaterThan(0)
    // Two probes happen outside the loop (the early-return check and the one
    // inside releaseKeepingRegistration); every remaining probe is preceded by
    // a sleep. Anything less means an unthrottled iteration slipped through.
    expect(sleeps.length).toBeGreaterThanOrEqual(probes - 2)
  })

  it('backs off: gaps widen and then cap', () => {
    const { sleeps } = attachOnce()
    expect(sleeps[0]).toBe(10)
    // Non-decreasing, doubling, and never past the ceiling — so a loop that
    // runs its whole budget out stops hammering, while the first probes stay
    // as prompt as they were.
    for (let i = 1; i < sleeps.length; i += 1) {
      expect(sleeps[i]).toBeGreaterThanOrEqual(sleeps[i - 1])
      expect(sleeps[i]).toBeLessThanOrEqual(100)
    }
    if (sleeps.length > 4) expect(Math.max(...sleeps)).toBeGreaterThan(sleeps[0])
  })
})
