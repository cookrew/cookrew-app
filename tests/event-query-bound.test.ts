// The live event query stops growing with the log.
//
// Measured on the owner's live session while they reported rising input
// latency: /api/events/query with NO limit returned 3170 events / 763KB, and
// useEventQuery re-ran it on EVERY streamed event. Two multipliers, both
// pointing the wrong way — the log grows with uptime, and events arrive in
// bursts as agents work. Same limit, sent: 13KB.
//
// The cost shape this refactor keeps having to unlearn: something that rises
// on its own while every in-process test stays green.
//
// The two multipliers get two fixes, tested apart because they are not the
// same fix:
//   COALESCE  kills frequency, and changes nothing about what is displayed.
//   LIMIT     kills size, and DOES change it for an unbounded range — so the
//             truncation is REPORTED rather than swallowed.
//
// Tested through pure helpers rather than a React harness: this repo has no
// renderer test infrastructure, and adding a dependency to test four lines of
// glue is the wrong trade. The hook composes these and nothing else.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyLimit,
  boundedFilter,
  createCoalescer,
  type EventFilter
} from '../src/renderer/src/event-log'
import type { CookrewEvent } from '../src/main/event-log'

const event = (timestamp: number): CookrewEvent =>
  ({ type: 'op', entityId: 'x', entityName: 'x', workspaceId: 'w', workspaceName: 'W', actor: 'user', timestamp }) as CookrewEvent

const log = (n: number): CookrewEvent[] => Array.from({ length: n }, (_, i) => event(i))

describe('boundedFilter — the query stops scaling with the log', () => {
  it('sends a limit even when the caller names none', () => {
    // The whole defect: no limit meant the server returned everything it had.
    expect(boundedFilter(undefined).limit).toBeGreaterThan(0)
    expect(boundedFilter({}).limit).toBeGreaterThan(0)
  })

  it("honours the caller's own limit rather than overriding it", () => {
    expect(boundedFilter({ limit: 25 }).limit).toBe(26)
  })

  it('asks for one MORE than the cap, which is how truncation is detected', () => {
    // Cheaper than a second count query, and it cannot report a truncation it
    // did not observe.
    expect(boundedFilter({ limit: 100 }).limit).toBe(101)
    expect(boundedFilter({}, 10).limit).toBe(11)
  })

  it('carries the rest of the filter through untouched', () => {
    const f: EventFilter = { workspaceId: 'ws-1', types: ['a'], since: 5, until: 9 }
    expect(boundedFilter(f)).toMatchObject(f)
  })
})

describe('applyLimit — truncation is reported, never swallowed', () => {
  it('reports truncation when the log had more', () => {
    // A panel showing metrics over "all" while holding only the newest N is a
    // wrong answer that looks right — the failure this workstream has been
    // bitten by twice.
    const result = applyLimit(log(5000), { limit: 100 })
    expect(result.truncated).toBe(true)
    expect(result.events).toHaveLength(100)
  })

  it('does NOT claim truncation when the log fits', () => {
    const result = applyLimit(log(10), { limit: 100 })
    expect(result.truncated).toBe(false)
    expect(result.events).toHaveLength(10)
  })

  it('does not claim truncation at exactly the limit', () => {
    // The off-by-one that would cry wolf on every full page.
    const result = applyLimit(log(100), { limit: 100 })
    expect(result.truncated).toBe(false)
    expect(result.events).toHaveLength(100)
  })

  it('keeps the NEWEST events when it truncates', () => {
    // Dropping the oldest is the only defensible direction for a metrics view.
    const result = applyLimit(log(500), { limit: 10 })
    const stamps = result.events.map((e) => e.timestamp)
    expect(stamps[stamps.length - 1]).toBe(499)
    expect(stamps[0]).toBe(490)
  })

  it('handles an empty log without claiming anything', () => {
    const result = applyLimit([], { limit: 100 })
    expect(result).toEqual({ events: [], truncated: false })
  })
})

describe('createCoalescer — a burst is one refetch, not one each', () => {
  it('collapses a burst into a single run', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const c = createCoalescer(400, run)

    // An agent working emits ops in clusters. Thirty used to mean thirty full
    // queries, thirty parses and thirty renders for one identical result.
    for (let i = 0; i < 30; i += 1) c.trigger()
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)

    expect(run).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('is TRAILING — it does not fire on the first trigger', () => {
    // Leading-edge would put the query back on the critical path of the first
    // event of every burst, which is the cost being removed.
    vi.useFakeTimers()
    const run = vi.fn()
    createCoalescer(400, run).trigger()
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(399)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('re-arms for a LATER burst — coalescing is not a one-shot', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const c = createCoalescer(400, run)

    c.trigger()
    vi.advanceTimersByTime(400)
    c.trigger()
    vi.advanceTimersByTime(400)

    expect(run).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('cancel stops a pending run — a timer surviving unmount is a leak', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const c = createCoalescer(400, run)

    c.trigger()
    c.cancel()
    vi.advanceTimersByTime(2000)

    expect(run).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('cancel is idempotent and safe with nothing pending', () => {
    vi.useFakeTimers()
    const c = createCoalescer(400, vi.fn())
    expect(() => {
      c.cancel()
      c.cancel()
    }).not.toThrow()
    vi.useRealTimers()
  })
})

/**
 * THE TWO PATHS MUST AGREE ABOUT WHICH END IS NEWEST.
 *
 * applyLimit trims by slicing the TAIL, so it is correct only if the query
 * returns oldest-first. The server's contract is oldest-first (main/event-log.ts
 * limits by `slice(length - limit)`, keeping the NEWEST) — but queryEvents used
 * to document "newest first" and its mock branch sorted DESCENDING. Composed,
 * the fallback path returned the OLDEST N and reported `truncated: true`: the
 * right count, trimmed off the wrong end, in the one mode where no server was
 * there to contradict it.
 *
 * Tested through the real queryEvents rather than a restatement of the sort, so
 * a future edit to either end is what fails.
 */
describe('queryEvents (mock path) serves the server contract', () => {
  /** Enough window for the mock adapter: no `cookrew`, so the bridge is absent
   *  and queryEvents takes its fallback branch. */
  const withMockWindow = async (): Promise<typeof import('../src/renderer/src/event-log')> => {
    vi.stubGlobal('window', new EventTarget())
    vi.resetModules()
    return import('../src/renderer/src/event-log')
  }
  /** The channel onEvent listens on when there is no real stream. */
  const MOCK_EVENT = 'cookrew:mock-event'

  const seed = (mod: Awaited<ReturnType<typeof withMockWindow>>, stamps: number[]): void => {
    mod.onEvent(() => {})
    for (const t of stamps) {
      window.dispatchEvent(new CustomEvent(MOCK_EVENT, { detail: event(t) }))
    }
  }

  afterEach(() => vi.unstubAllGlobals())

  it('returns OLDEST FIRST, whatever order the events arrived in', async () => {
    const mod = await withMockWindow()
    seed(mod, [500, 100, 900, 300])
    expect((await mod.queryEvents()).map((e) => e.timestamp)).toEqual([100, 300, 500, 900])
  })

  it('honours `limit` by keeping the NEWEST, exactly as the server does', async () => {
    // The mock stands in for the server, so a filter the server would honour
    // must not pass straight through here — otherwise applyLimit is the only
    // trimmer in this mode and the fallback silently diverges from production.
    const mod = await withMockWindow()
    seed(mod, [1, 2, 3, 4, 5])
    expect((await mod.queryEvents({ limit: 2 })).map((e) => e.timestamp)).toEqual([4, 5])
  })

  it('composed with boundedFilter + applyLimit, the NEWEST survive', async () => {
    // The end-to-end shape the hook runs, and the one that was inverted.
    const mod = await withMockWindow()
    seed(mod, [10, 20, 30, 40, 50])
    const raw = await mod.queryEvents(mod.boundedFilter({ limit: 3 }))
    const { events, truncated } = mod.applyLimit(raw, { limit: 3 })

    expect(events.map((e) => e.timestamp)).toEqual([30, 40, 50])
    expect(truncated).toBe(true)
  })
})
