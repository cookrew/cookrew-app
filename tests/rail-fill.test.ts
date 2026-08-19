import { describe, expect, it } from 'vitest'
import {
  capacityFor,
  fillRows,
  RAIL_INSET,
  ROW_HEIGHT,
  sampleIndices
} from '../src/renderer/src/rail-fill'
import type { CheckpointRow } from '../src/renderer/src/transcript'

/**
 * F3, measured on a live agent before this existed: 25 rows, T23…T47 out of
 * 122, spanning 169% of the bar — a window that overflows the rail at both ends
 * and still contains neither T1 nor LIVE. These tests hold the density rule
 * that replaced it: fill the bar, pin the ends, never draw the focused row
 * twice (a second copy a pixel off the marker is exactly what F6 catches).
 */

const rowsOf = (n: number): CheckpointRow[] =>
  Array.from({ length: n }, (_, i) => ({ index: i + 1, record: null }) as unknown as CheckpointRow)

describe('capacityFor', () => {
  it('counts the USABLE span, not the full bar height', () => {
    // Deliberate move: this asserted `barHeight / ROW_HEIGHT`, which is where
    // the overcount lived. railAnchorTop insets both ends by RAIL_INSET, so
    // two insets' worth of pixels are never available to lay rows in.
    const usable = (h: number): number => Math.floor((h - 2 * RAIL_INSET) / ROW_HEIGHT)
    expect(capacityFor(669)).toBe(usable(669))
    expect(capacityFor(669)).toBeLessThan(Math.floor(669 / ROW_HEIGHT))
    // A bar exactly five rows tall holds four once the insets are honoured.
    expect(capacityFor(ROW_HEIGHT * 5)).toBe(4)
  })

  it('never drops below the two ends themselves', () => {
    // T1 and LIVE are the claim; a bar too short for more still makes it.
    expect(capacityFor(10)).toBe(2)
    expect(capacityFor(0)).toBe(2)
  })
})

describe('sampleIndices', () => {
  it('keeps both ends', () => {
    const picked = sampleIndices(122, 19)
    expect(picked[0]).toBe(0)
    expect(picked[picked.length - 1]).toBe(121)
  })

  it('returns everything when it all fits', () => {
    expect(sampleIndices(4, 19)).toEqual([0, 1, 2, 3])
  })

  it('spreads evenly and never repeats an index', () => {
    const picked = sampleIndices(100, 10)
    expect(new Set(picked).size).toBe(picked.length)
    expect([...picked].sort((a, b) => a - b)).toEqual(picked)
    const gaps = picked.slice(1).map((v, i) => v - picked[i])
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1)
  })

  it('handles the degenerate sizes without throwing', () => {
    expect(sampleIndices(0, 10)).toEqual([])
    expect(sampleIndices(5, 1)).toEqual([0])
  })
})

describe('fillRows', () => {
  const rows = rowsOf(122)

  it('reaches T1 and the newest checkpoint — the whole point of F3', () => {
    const filled = fillRows(rows, 669, null)
    expect(filled[0].row.index).toBe(1)
    expect(filled[filled.length - 1].row.index).toBe(122)
  })

  it('spans the bar from the top, leaving the live tail clear', () => {
    // R19: a row is a SPAN, so row `at` owns [at/n, (at+1)/n) and the last 1/n
    // belongs to the live tail — the live dot and the LIVE row. The newest
    // CHECKPOINT therefore stops at (n-1)/n instead of taking the bottom.
    // F3 still holds: T1 at the top, LIVE at the bottom, now as its own row.
    const filled = fillRows(rows, 669, null)
    expect(filled[0].fraction).toBe(0)
    expect(filled[filled.length - 1].fraction).toBe((rows.length - 1) / rows.length)
    expect(filled[filled.length - 1].fraction).toBeLessThan(1)
  })

  /**
   * The real gate: PIXELS, not a restatement of capacityFor.
   *
   * `filled.length <= capacityFor(h)` asserted the function against itself and
   * passed happily while rows overlapped — capacityFor divided the full bar
   * height though the layout only spans `h - 2 * RAIL_INSET`, so at h = 136 it
   * allowed 4 rows 26px apart for 34px rows. Now that F5 makes rows opaque,
   * that is rows clipping each other.
   *
   * This mirrors railAnchorTop's own arithmetic — `calc(16px + f * (100% -
   * 32px))` — and asserts the smallest gap any two neighbours actually get.
   */
  const topsFor = (filled: { fraction: number }[], barHeight: number): number[] =>
    filled.map((f) => RAIL_INSET + f.fraction * (barHeight - 2 * RAIL_INSET))

  const minGap = (tops: number[]): number =>
    tops.length < 2 ? Infinity : Math.min(...tops.slice(1).map((t, i) => t - tops[i]))

  it('never lays two rows closer together than a row is tall', () => {
    for (const barHeight of [136, 200, 340, 480, 669, 900]) {
      const filled = fillRows(rows, barHeight, null)
      const gap = minGap(topsFor(filled, barHeight))
      expect(
        gap,
        `bar ${barHeight}px laid ${filled.length} rows, closest pair ${gap.toFixed(1)}px apart`
      ).toBeGreaterThanOrEqual(ROW_HEIGHT)
    }
  })

  it('still fills a tall bar rather than under-using it', () => {
    // The inset correction must not turn into timidity: one more row than we
    // lay would have to breach ROW_HEIGHT somewhere.
    const filled = fillRows(rows, 669, null)
    expect(filled.length).toBeGreaterThanOrEqual(17)
    expect(filled.length).toBeLessThanOrEqual(capacityFor(669))
  })

  it('shows both ends even when the bar is far too short for them', () => {
    const filled = fillRows(rows, 40, null)
    expect(filled.map((f) => f.row.index)).toEqual([1, 122])
  })

  it('omits the focused row so it is never drawn twice', () => {
    // The focus is rendered separately AT the marker fraction. A sampled copy
    // sits at its own fraction — a second row a few px off the marker, which
    // reads as the alignment gate failing.
    const filled = fillRows(rows, 669, 1)
    expect(filled.some((f) => f.row.index === 1)).toBe(false)
  })

  it('leaves the other rows alone when the focus is not among the sample', () => {
    const filled = fillRows(rows, 669, 2)
    expect(filled.some((f) => f.row.index === 2)).toBe(false)
    expect(filled[0].row.index).toBe(1)
  })

  it('shows every row when the conversation is shorter than the bar', () => {
    const filled = fillRows(rowsOf(3), 669, null)
    expect(filled.map((f) => f.row.index)).toEqual([1, 2, 3])
    // Thirds, not halves: three spans over the bar, the last third left for LIVE.
    expect(filled.map((f) => f.fraction)).toEqual([0, 1 / 3, 2 / 3])
  })

  it('survives an empty conversation', () => {
    expect(fillRows([], 669, null)).toEqual([])
  })

  it('puts a single checkpoint at the top rather than dividing by zero', () => {
    expect(fillRows(rowsOf(1), 669, null)).toEqual([{ row: rowsOf(1)[0], fraction: 0 }])
  })
})
