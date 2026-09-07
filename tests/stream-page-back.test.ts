// THE RAIL PAGES BACKWARDS (D1, T5 QA 2026-09-07).
//
// useStream exposed `pageBack()` and `atOldest` from T3 and NOTHING CALLED
// THEM: the loaded set was /stream/open's newest 100 rows unioned with the
// drawer's oldest-20 prefetch, so on the owner's 1,048-row card T16…T950 were
// reachable only as a side effect of scrubbing — while the bar was drawn as
// if it spanned the whole conversation.
//
// House pattern for the hook: no jsdom and no @testing-library (neither is a
// dependency). The reducer is pure and the trigger policy is pure, so the
// contract is argued as arithmetic; the hook's own plumbing is exercised
// through a hand-driven transport in tests/stream-pager.test.ts's style.

import { describe, expect, it } from 'vitest'
import {
  createPageBackRunner,
  isOrdinalLoaded,
  maxPageBackSteps,
  oldestOrdinal,
  PAGE_BACK_THRESHOLD,
  shouldPageBack
} from '../src/renderer/src/stream/page-back'
import {
  initialStreamState,
  streamReducer,
  type StreamState
} from '../src/renderer/src/stream/stream-reducer'
import { railFraction, railScale, fillRows } from '../src/renderer/src/rail-fill'
import { rowsOfIndex, scrubOrdinal, scrubPreviewRow } from '../src/renderer/src/stream/stream-rows'
import type { StreamCheckpoint } from '../src/renderer/src/stream/stream-types'

const row = (ordinal: number): StreamCheckpoint => ({
  identity: `u${ordinal}`,
  ordinal,
  startedAt: ordinal,
  endedAt: ordinal,
  promptHead: `prompt ${ordinal}`,
  compacted: false,
  file: '/s1.jsonl'
})

/** The page a 1,048-row card opens with: the newest hundred, nothing else. */
const newestPage = (): StreamCheckpoint[] =>
  Array.from({ length: 100 }, (_, at) => row(949 + at))

describe('shouldPageBack — the trigger policy', () => {
  const base = { oldestLoaded: 949, atOldest: false, inFlight: false }

  it('fires within the threshold of the oldest row loaded, and not before', () => {
    expect(shouldPageBack({ ...base, reached: 949 + PAGE_BACK_THRESHOLD })).toBe(true)
    expect(shouldPageBack({ ...base, reached: 949 + PAGE_BACK_THRESHOLD + 1 })).toBe(false)
    expect(shouldPageBack({ ...base, reached: 1048 })).toBe(false)
  })

  it('fires for an ordinal OLDER than anything loaded — the scrub to the top', () => {
    expect(shouldPageBack({ ...base, reached: 1 })).toBe(true)
    expect(shouldPageBack({ ...base, reached: 340 })).toBe(true)
  })

  it('atOldest stops it, whatever is reached', () => {
    expect(shouldPageBack({ ...base, atOldest: true, reached: 1 })).toBe(false)
    expect(shouldPageBack({ ...base, atOldest: true, reached: 949 })).toBe(false)
  })

  it('a page already on the wire stops it — one in flight at a time', () => {
    expect(shouldPageBack({ ...base, inFlight: true, reached: 1 })).toBe(false)
  })

  it('a client holding nothing does not guess', () => {
    expect(shouldPageBack({ ...base, oldestLoaded: null, reached: 1 })).toBe(false)
  })

  it('EXACTLY ONE page per reach: the guard is the caller’s in-flight flag', () => {
    // A scrub fires per pointer event. The first reach is allowed; every
    // reach while that page is on the wire is refused, which is what keeps
    // ten identical ?before= requests off the wire.
    const drag = [1048, 1000, 960, 950, 940, 900, 500, 1]
    let inFlight = false
    let fired = 0
    for (const reached of drag) {
      if (shouldPageBack({ ...base, reached, inFlight })) {
        fired += 1
        inFlight = true
      }
    }
    expect(fired).toBe(1)
  })
})

describe('the loaded set, and the bound on catching up to a checkpoint', () => {
  it('oldestOrdinal and isOrdinalLoaded read the window, not the chain', () => {
    const index = newestPage()
    expect(oldestOrdinal(index)).toBe(949)
    expect(oldestOrdinal([])).toBeNull()
    expect(isOrdinalLoaded(index, 949)).toBe(true)
    expect(isOrdinalLoaded(index, 948)).toBe(false)
    expect(isOrdinalLoaded([], 1)).toBe(false)
  })

  it('maxPageBackSteps covers the chain and stops a cursor that never moves', () => {
    // 1,048 rows at 100 a page is ten pages; the spare covers the partial one.
    expect(maxPageBackSteps(1048, 100)).toBe(12)
    expect(maxPageBackSteps(0, 100)).toBe(1)
    expect(maxPageBackSteps(Number.NaN, 100)).toBe(1)
  })
})

/**
 * The runner, over the REAL reducer — the same fold the hook performs, with
 * the transport replaced by a hand-driven page. Nothing is mounted: the order
 * of decisions is the whole contract and it has no React in it.
 */
function bed(options: { total?: number; oldestPage?: number } = {}) {
  const total = options.total ?? 1048
  const oldest = options.oldestPage ?? 1
  let state: StreamState = streamReducer(initialStreamState('t1'), {
    kind: 'open',
    open: {
      index: newestPage(),
      tail: null,
      backwardsCursor: 'u949',
      source: 'file',
      anomalies: {},
      rolledBack: []
    }
  })
  state = { ...state, total }
  let fetches = 0
  /** Resolvers for pages held open, so overlap is observable. */
  const held: Array<() => void> = []
  const runner = createPageBackRunner({
    pageSize: 100,
    state: () => ({
      oldestLoaded: oldestOrdinal(state.index),
      atOldest: state.backwardsCursor === null,
      total: state.total
    }),
    fetch: async () => {
      fetches += 1
      await new Promise<void>((resolve) => held.push(resolve))
      const from = oldestOrdinal(state.index) as number
      const start = Math.max(oldest, from - 100)
      const rows = Array.from({ length: from - start }, (_, at) => row(start + at))
      state = streamReducer(state, {
        kind: 'index',
        checkpoints: rows,
        backwardsCursor: start <= oldest ? null : `u${start}`,
        total
      })
    }
  })
  return {
    runner,
    fetches: () => fetches,
    oldest: () => oldestOrdinal(state.index),
    atOldest: () => state.backwardsCursor === null,
    /** Let every page in flight land. */
    settle: async () => {
      for (const resolve of held.splice(0)) resolve()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

describe('the runner — one page in flight, and a bounded catch-up', () => {
  it('a whole scrub drag puts EXACTLY ONE page on the wire', async () => {
    const rail = bed()
    for (const ordinal of [1048, 1000, 960, 950, 940, 900, 500, 1]) rail.runner.reach(ordinal)
    expect(rail.fetches()).toBe(1)
    expect(rail.runner.inFlight()).toBe(true)
    await rail.settle()
    expect(rail.oldest()).toBe(849)
  })

  it('a reach well clear of the oldest row fetches nothing at all', async () => {
    const rail = bed()
    rail.runner.reach(1048)
    rail.runner.reach(1000)
    expect(rail.fetches()).toBe(0)
    await rail.settle()
  })

  it('atOldest suppresses every further ask', async () => {
    // Walk to the chain's start, then keep scrubbing at the top.
    const rail = bed({ oldestPage: 949 })
    rail.runner.reach(1)
    await rail.settle()
    expect(rail.atOldest()).toBe(true)
    const settled = rail.fetches()
    for (const ordinal of [1, 2, 3]) rail.runner.reach(ordinal)
    expect(rail.fetches()).toBe(settled)
  })

  it('ensureLoaded pages until the checkpoint is in, and stops at that page', async () => {
    const rail = bed()
    const walking = rail.runner.ensureLoaded(700)
    for (let n = 0; n < 12; n += 1) await rail.settle()
    await walking
    expect(rail.oldest()).toBeLessThanOrEqual(700)
    // Three pages of 100 reach 649 from 949 — and it does not walk to T1.
    expect(rail.fetches()).toBe(3)
    expect(rail.atOldest()).toBe(false)
  })

  it('ensureLoaded is a no-op for a checkpoint already loaded', async () => {
    const rail = bed()
    await rail.runner.ensureLoaded(1000)
    expect(rail.fetches()).toBe(0)
  })

  it('a server whose cursor never advances is asked once, not forever', async () => {
    let fetches = 0
    const runner = createPageBackRunner({
      pageSize: 100,
      // Stuck: never atOldest, never any older row.
      state: () => ({ oldestLoaded: 949, atOldest: false, total: 1048 }),
      fetch: async () => {
        fetches += 1
      }
    })
    await runner.ensureLoaded(1)
    expect(fetches).toBe(1)
  })
})

describe('the rail’s scale is the CHAIN, not the page loaded', () => {
  it('railScale takes total, and never falls below the newest ordinal', () => {
    const rows = rowsOfIndex(newestPage())
    expect(railScale(rows, 1048)).toBe(1048)
    // A `total` that lags a live append must not push the newest past LIVE.
    expect(railScale(rows, 3)).toBe(1048)
    // No total at all: the newest ordinal is the honest stand-in.
    expect(railScale(rows)).toBe(1048)
    expect(railScale([], 1048)).toBe(1048)
  })

  it('T1 sits at the top of the bar BEFORE it is loaded — the F3 claim', () => {
    // The whole defect in one assertion: with the loaded count as the
    // denominator the newest page spanned the entire bar, so a drag to the
    // top landed on T949 and T1 had no position at all.
    expect(railFraction(1, 1048)).toBe(0)
    expect(railFraction(949, 1048)).toBeCloseTo(0.9046, 4)
    expect(railFraction(1048, 1048)).toBeCloseTo(0.999, 3)
  })

  it('a fully paged rail is laid out exactly as it was before the scale existed', () => {
    // Equivalence gate: when every row is loaded, ordinal-over-total IS
    // arrayPosition-over-rows.length, so F1–F6 argue about the same numbers.
    const rows = rowsOfIndex(Array.from({ length: 122 }, (_, at) => row(at + 1)))
    for (const height of [0, 60, 136, 320, 669, 1080]) {
      expect(fillRows(rows, height, null, 122)).toEqual(fillRows(rows, height, null))
      expect(fillRows(rows, height, null, undefined)).toEqual(fillRows(rows, height, null))
    }
  })

  it('the newest page alone lays only what it holds, near the tail', () => {
    const rows = rowsOfIndex(newestPage())
    const laid = fillRows(rows, 669, null, 1048)
    // Every laid checkpoint is one this client actually has…
    for (const entry of laid) {
      if (entry.row === null) continue
      expect(entry.row.index).toBeGreaterThanOrEqual(949)
      // …and sits where the WHOLE chain says it does, not at the top.
      expect(entry.fraction).toBeGreaterThan(0.8)
    }
    // LIVE is still the last entry, at 1.
    expect(laid[laid.length - 1]).toEqual({ row: null, fraction: 1 })
  })
})

describe('a scrub names an ordinal on the chain, loaded or not', () => {
  it('scrubOrdinal maps the drag over the whole conversation', () => {
    expect(scrubOrdinal(0, 1048)).toBe(1)
    expect(scrubOrdinal(0.5, 1048)).toBe(525)
    expect(scrubOrdinal(1, 1048)).toBe(1048)
    // Clamped, never off the ends.
    expect(scrubOrdinal(-2, 1048)).toBe(1)
    expect(scrubOrdinal(9, 1048)).toBe(1048)
  })

  it('the preview tab shows the NEAREST loaded row while the page is fetched', () => {
    const rows = rowsOfIndex(newestPage())
    expect(scrubPreviewRow(rows, 0, 1048)?.index).toBe(949)
    expect(scrubPreviewRow(rows, 1, 1048)?.index).toBe(1048)
    // Without a scale the old loaded-space rule stands, byte for byte.
    expect(scrubPreviewRow(rows, 0.5)?.index).toBe(rows[Math.round(0.5 * 99)].index)
  })
})
