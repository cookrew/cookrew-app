import { describe, expect, it } from 'vitest'
import { cursorScrollTop, fitFontSize, shrunkFontSize } from '../src/renderer/src/routing/screen-fit'

/**
 * Box round 3, N7: the wait pane clipped Claude's own screens, the bypass consent
 * among them, so a person agreed to a warning they could not fully read. The pane
 * follows the PTY's size, so a screen wider or taller than the box was cut.
 */

const BASE = 12

describe('the type size that shows a whole screen', () => {
  it('stays at the base size when the screen fits', () => {
    expect(fitFontSize({ screen: { width: 500, height: 200 }, box: { width: 600, height: 340 }, current: BASE, base: BASE, whole: true })).toBe(BASE)
  })

  it('shrinks to the width: the end of a line must be readable', () => {
    expect(fitFontSize({ screen: { width: 1000, height: 200 }, box: { width: 600, height: 340 }, current: BASE, base: BASE, whole: true })).toBe(7)
  })

  it('shrinks to the height too when the whole screen is wanted', () => {
    expect(fitFontSize({ screen: { width: 500, height: 680 }, box: { width: 600, height: 510 }, current: BASE, base: BASE, whole: true })).toBe(9)
  })

  it('leaves the height alone for a shell, which is read at its last line', () => {
    expect(fitFontSize({ screen: { width: 500, height: 680 }, box: { width: 600, height: 200 }, current: BASE, base: BASE, whole: false })).toBe(BASE)
  })

  it('works from the size in use: a screen drawn small may fit at a larger one', () => {
    expect(fitFontSize({ screen: { width: 300, height: 100 }, box: { width: 600, height: 340 }, current: 6, base: BASE, whole: true })).toBe(BASE)
  })

  it('stops at a size that can still be read: past that the box scrolls', () => {
    expect(fitFontSize({ screen: { width: 4000, height: 200 }, box: { width: 300, height: 340 }, current: BASE, base: BASE, whole: true })).toBe(6)
  })

  it('leaves the size alone with nothing laid out yet', () => {
    expect(fitFontSize({ screen: { width: 0, height: 0 }, box: { width: 600, height: 340 }, current: BASE, base: BASE, whole: true })).toBe(BASE)
    expect(fitFontSize({ screen: { width: 500, height: 200 }, box: { width: 0, height: 0 }, current: BASE, base: BASE, whole: true })).toBe(BASE)
  })
})

describe('the size settles', () => {
  // Rows are whole pixels, so size and height do not scale together, and a fit that
  // could grow again flipped between two sizes for ever, one repaint after another.
  const drawn = (size: number, rows: number, cols: number) => ({ width: cols * size * 0.6, height: rows * Math.ceil(size * 1.17) })

  it('never moves more than a few times, on any grid and box', () => {
    for (let rows = 20; rows <= 60; rows += 1) {
      for (let boxHeight = 300; boxHeight <= 560; boxHeight += 7) {
        let size = 12
        let moves = 0
        for (let i = 0; i < 40; i += 1) {
          const next = shrunkFontSize({ screen: drawn(size, rows, 130), box: { width: 600, height: boxHeight }, current: size, base: 12, whole: true })
          if (next !== size) moves += 1
          expect(next).toBeLessThanOrEqual(size)
          size = next
        }
        expect(moves).toBeLessThanOrEqual(12)
      }
    }
  })
})

describe('the box follows the cursor, which is where a prompt is', () => {
  // The grid is the card's and can be far taller than the box: pinned to the bottom,
  // a sudo prompt near the top of a young pane was above the fold of its own box.
  const at = (cursorRow: number) => cursorScrollTop({ cursorRow, rows: 40, screenHeight: 600, boxHeight: 200, padding: 6 })

  it('stays at the top while the cursor is in the first box full', () => {
    expect(at(0)).toBe(0)
    expect(at(10)).toBe(0)
  })

  it('brings a cursor further down to the foot of the box', () => {
    expect(at(30)).toBe(31 * 15 + 6 - 200)
  })

  it('reaches the last row', () => {
    expect(at(39)).toBe(40 * 15 + 6 - 200)
  })

  it('stays put with nothing laid out', () => {
    expect(cursorScrollTop({ cursorRow: 5, rows: 0, screenHeight: 0, boxHeight: 200, padding: 0 })).toBe(0)
  })
})
