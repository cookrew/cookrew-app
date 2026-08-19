import { describe, expect, it } from 'vitest'
import { capacityFor, fillRows, ROW_HEIGHT, sampleIndices } from '../src/renderer/src/rail-fill'
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
  it('fits as many whole rows as the bar height allows', () => {
    expect(capacityFor(669)).toBe(Math.floor(669 / ROW_HEIGHT))
    expect(capacityFor(ROW_HEIGHT * 5)).toBe(5)
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

  it('spans the full bar: first fraction 0, last fraction 1', () => {
    const filled = fillRows(rows, 669, null)
    expect(filled[0].fraction).toBe(0)
    expect(filled[filled.length - 1].fraction).toBe(1)
  })

  it('lays no more rows than the bar can hold without overlap', () => {
    const filled = fillRows(rows, 669, null)
    expect(filled.length).toBeLessThanOrEqual(capacityFor(669))
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
    expect(filled.map((f) => f.fraction)).toEqual([0, 0.5, 1])
  })

  it('survives an empty conversation', () => {
    expect(fillRows([], 669, null)).toEqual([])
  })

  it('puts a single checkpoint at the top rather than dividing by zero', () => {
    expect(fillRows(rowsOf(1), 669, null)).toEqual([{ row: rowsOf(1)[0], fraction: 0 }])
  })
})
