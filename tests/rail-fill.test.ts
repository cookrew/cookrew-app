import { describe, expect, it } from 'vitest'
import { capacityFor, fillRows, isLive, RAIL_INSET, ROW_HEIGHT, sampleIndices, countBadgeTop, PIN_HALF_H, COUNT_GAP } from '../src/renderer/src/rail-fill'
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

  it('reaches T1 at the top and LIVE at the bottom — the whole point of F3', () => {
    const filled = fillRows(rows, 669, null)
    expect(filled[0].row?.index).toBe(1)
    expect(isLive(filled[filled.length - 1])).toBe(true)
    expect(filled[filled.length - 1].fraction).toBe(1)
  })

  it('drops only the tail checkpoints that cannot clear LIVE', () => {
    // Deliberate: fractions stay at/n, so a checkpoint too close to the tail is
    // omitted rather than moved off its own position. It is still reachable by
    // scrub — the focused row draws it exactly on the marker.
    const filled = fillRows(rows, 669, null)
    const newest = filled.filter((f) => !isLive(f)).pop()
    expect(newest?.row?.index).toBeLessThan(122)
    expect(newest!.fraction).toBeLessThanOrEqual(1 - ROW_HEIGHT / (669 - 2 * RAIL_INSET))
    // …and it is still a real position, not a capped one.
    expect(newest!.fraction).toBe((newest!.row!.index - 1) / rows.length)
  })

  it('spans the bar from the top, with the live tail its own entry', () => {
    // R19: a row is a SPAN, so row `at` owns [at/n, (at+1)/n) and the last 1/n
    // belongs to the live tail — the live dot and the LIVE row. The newest
    // CHECKPOINT therefore stops at (n-1)/n instead of taking the bottom.
    // F3 still holds: T1 at the top, LIVE at the bottom, now as its own row.
    const filled = fillRows(rows, 669, null)
    expect(filled[0].fraction).toBe(0)
    const checkpoints = filled.filter((f) => !isLive(f))
    expect(checkpoints[checkpoints.length - 1].fraction).toBeLessThan(1)
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
  const topsFor = (filled: readonly { fraction: number }[], barHeight: number): number[] =>
    filled.map((f) => RAIL_INSET + f.fraction * (barHeight - 2 * RAIL_INSET))

  const minGap = (tops: number[]): number =>
    tops.length < 2 ? Infinity : Math.min(...tops.slice(1).map((t, i) => t - tops[i]))

  it('never lays two rows closer together than a row is tall — LIVE INCLUDED', () => {
    // TWO dimensions, because one alone missed two separate bugs. Height alone
    // missed LIVE landing on the newest checkpoint; height at a single ledger
    // size missed sampleIndices' rounding, where a fractional step puts two
    // picks ONE index apart while the capacity budget assumed the average.
    for (const n of [19, 30, 60, 122]) {
      const ledger = rowsOf(n)
      for (const barHeight of [136, 200, 340, 480, 669, 900]) {
        const filled = fillRows(ledger, barHeight, null)
        expect(filled.some(isLive), `n=${n} bar ${barHeight}px laid no LIVE`).toBe(true)
        const gap = minGap(topsFor(filled, barHeight))
        expect(
          gap,
          `n=${n} bar ${barHeight}px laid ${filled.length} entries, closest pair ${gap.toFixed(1)}px apart`
        ).toBeGreaterThanOrEqual(ROW_HEIGHT)
      }
    }
  })

  it('holds the gap for EVERY ledger size, not just the sampled ones', () => {
    // The four sizes above are the readable gate; this is the exhaustive one.
    // sampleIndices' rounding failed for 71 of these 199 lengths at H=669, and
    // which lengths collide is not something to guess at — n=33 was the worst
    // at 19.3px and n=19/340px is what the sampled loop happened to catch.
    const violations: string[] = []
    for (const barHeight of [136, 200, 340, 480, 669, 900]) {
      for (let n = 2; n <= 200; n++) {
        const tops = topsFor(fillRows(rowsOf(n), barHeight, null), barHeight)
        const gap = minGap(tops)
        if (gap < ROW_HEIGHT) violations.push(`n=${n} h=${barHeight} ${gap.toFixed(1)}px`)
      }
    }
    expect(violations).toEqual([])
  })

  it('holds the gap with the focused row pulled out, too', () => {
    // Excluding the focus leaves a hole; the remaining neighbours must still
    // not collide with each other or with LIVE.
    for (const barHeight of [200, 340, 669]) {
      for (const focus of [1, 61, 122]) {
        const filled = fillRows(rows, barHeight, focus)
        expect(minGap(topsFor(filled, barHeight))).toBeGreaterThanOrEqual(ROW_HEIGHT)
      }
    }
  })

  it('still fills a tall bar rather than under-using it', () => {
    // The inset correction and LIVE's slot must not turn into timidity: one
    // more entry than we lay would have to breach ROW_HEIGHT somewhere.
    const filled = fillRows(rows, 669, null)
    expect(filled.length).toBeGreaterThanOrEqual(15)
    expect(filled.length).toBeLessThanOrEqual(capacityFor(669))
  })

  it('keeps LIVE even when the bar is far too short for anything else', () => {
    // At 40px there is 8px of usable span: no checkpoint can be a row clear of
    // the tail, so the honest answer is the tail alone.
    expect(fillRows(rows, 40, null)).toEqual([{ row: null, fraction: 1 }])
  })

  it('omits the focused row so it is never drawn twice', () => {
    // The focus is rendered separately AT the marker fraction. A sampled copy
    // sits at its own fraction — a second row a few px off the marker, which
    // reads as the alignment gate failing.
    const filled = fillRows(rows, 669, 1)
    expect(filled.some((f) => f.row?.index === 1)).toBe(false)
  })

  it('leaves the other rows alone when the focus is not among the sample', () => {
    const filled = fillRows(rows, 669, 2)
    expect(filled.some((f) => f.row?.index === 2)).toBe(false)
    expect(filled[0].row?.index).toBe(1)
  })

  it('shows every row when the conversation is shorter than the bar', () => {
    const filled = fillRows(rowsOf(3), 669, null)
    expect(filled.map((f) => f.row?.index)).toEqual([1, 2, 3, undefined])
    // Thirds, not halves: three spans over the bar, then LIVE on the last.
    expect(filled.map((f) => f.fraction)).toEqual([0, 1 / 3, 2 / 3, 1])
  })

  it('survives an empty conversation', () => {
    expect(fillRows([], 669, null)).toEqual([])
  })

  it('puts a single checkpoint at the top rather than dividing by zero', () => {
    expect(fillRows(rowsOf(1), 669, null)).toEqual([
      { row: rowsOf(1)[0], fraction: 0 },
      { row: null, fraction: 1 }
    ])
  })
})

/**
 * The CP badge and a version pin at the top of the bar want the same 20px.
 * Hiding the pin loses a control, fading the badge loses a readout, so the
 * badge steps aside — and only where a pin actually reaches it.
 */
describe('countBadgeTop — the badge yields, and only where a pin is', () => {
  const H = 663

  it('does not move when there are no pins at all', () => {
    expect(countBadgeTop([], H)).toBeNull()
  })

  it('does not move for pins that never reach it', () => {
    // Mid-bar and bottom pins are nowhere near the badge's band.
    expect(countBadgeTop([0.4, 0.7, 0.9], H)).toBeNull()
  })

  it('steps past a pin on the oldest drawn row — the fresh-install case', () => {
    const top = countBadgeTop([0], H)
    const pinBottom = RAIL_INSET + 0 * (H - 2 * RAIL_INSET) + PIN_HALF_H
    expect(top).toBe(pinBottom + COUNT_GAP)
  })

  it('clears the pin it stepped around, with the gap intact', () => {
    const top = countBadgeTop([0], H)!
    const pinBottom = RAIL_INSET + PIN_HALF_H
    expect(top).toBeGreaterThanOrEqual(pinBottom)
    expect(top - pinBottom).toBe(COUNT_GAP)
  })

  it('does NOT chase the lowest pin down the bar', () => {
    // The first cut took the max of every pin below the badge and parked the
    // count two thirds of the way down a rail whose only collision was at top.
    const withFarPins = countBadgeTop([0, 0.5, 0.95], H)!
    const topOnly = countBadgeTop([0], H)!
    expect(withFarPins).toBe(topOnly)
    expect(withFarPins).toBeLessThan(H / 4)
  })

  it('keeps stepping while pins are stacked in its way', () => {
    // Two pins close enough that clearing the first lands on the second.
    const stacked = countBadgeTop([0, 0.03], H)!
    const single = countBadgeTop([0], H)!
    expect(stacked).toBeGreaterThan(single)
  })

  it('leaves the badge alone before the rail has been measured', () => {
    expect(countBadgeTop([0], 0)).toBeNull()
  })
})
