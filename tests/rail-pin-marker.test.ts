import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pinAnchors, pinLabel, type VersionPinRecord } from '../src/shared/version-pin'

const RAIL = readFileSync(join(__dirname, '../src/renderer/src/CheckpointTimeline.tsx'), 'utf8')
const CSS = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')

const rowsOf = (n: number): { index: number }[] => Array.from({ length: n }, (_, i) => ({ index: i + 1 }))
const pin = (version: number, atIndex: number): VersionPinRecord => ({
  version,
  atIndex,
  scrollLine: atIndex * 10,
  cutAt: 1755648000000
})

/**
 * The pin marker's whole safety property is that it computes NO position of its
 * own. It asks pinAnchors for a fraction in the drawn-row space every other
 * mark already uses, and hands it to railAnchorTop. These lock that down at the
 * source, because a second position source is exactly how F6 regressed before.
 */
describe('the pin marker borrows the rail’s anchor, it does not invent one', () => {
  it('positions pins from railAnchorTop and nothing else', () => {
    const block = RAIL.slice(RAIL.indexOf('cr-ckpt-pin'), RAIL.indexOf('cr-ckpt-count'))
    expect(block).toMatch(/style=\{\{ top: railAnchorTop\(p\.frac\) \}\}/)
    // no local arithmetic on the fraction anywhere in the pin block
    expect(block).not.toMatch(/frac\s*[*/+-]/)
  })

  it('takes its fractions from pinAnchors, not from a local formula', () => {
    expect(RAIL).toMatch(/pinAnchors\(pins \?\? \[\], rows\)/)
  })

  it('does NOT adopt railMarkers, which still places trace ticks a row early', () => {
    // railMarkers puts a boundary at pinFraction(afterIndex) — the START of the
    // span of the checkpoint it FOLLOWS. The shipped rail uses (at + 1) / n.
    // Adopting it here would regress ticks that are currently correct.
    expect(RAIL).not.toMatch(/railMarkers/)
  })
})

describe('R8 label classes reach the rail intact', () => {
  it('labels v1–v9 with the V', () => {
    expect(pinLabel(1)).toEqual({ text: 'V1', labelled: true })
    expect(pinLabel(9)).toEqual({ text: 'V9', labelled: true })
  })

  it('drops the V for 10–99, which the 19px flag cannot hold', () => {
    expect(pinLabel(10)).toEqual({ text: '10', labelled: true })
    expect(pinLabel(99)).toEqual({ text: '99', labelled: true })
  })

  it('carries no label at all from v100', () => {
    expect(pinLabel(100)).toEqual({ text: '', labelled: false })
  })

  it('renders the unlabelled flag as .bare and still names the version', () => {
    expect(RAIL).toMatch(/label\.labelled \? '' : ' bare'/)
    expect(RAIL).toMatch(/title=\{`Version \$\{p\.version\}`\}/)
    expect(CSS).toMatch(/\.cr-ckpt-pin\.bare/)
  })
})

describe('a pin with no drawn row is omitted, never guessed', () => {
  it('drops a pin whose checkpoint is not on the rail', () => {
    expect(pinAnchors([pin(1, 99)], rowsOf(10))).toEqual([])
  })

  it('draws nothing at all when no rows are drawn', () => {
    expect(pinAnchors([pin(1, 1), pin(2, 5)], [])).toEqual([])
  })

  it('keeps the pins that DO land, and drops only the others', () => {
    const got = pinAnchors([pin(1, 5), pin(2, 99)], rowsOf(10))
    expect(got).toEqual([{ version: 1, frac: 0.4 }])
  })
})

/**
 * The R17 regression, asserted BOTH ways. A one-sided check passes on a rail
 * that has silently reverted to turn-number space, because the two agree on the
 * 106 contiguous ledgers out of 125 — which is precisely how the v1 bug lived.
 */
describe('drawn-row space, not turn-number space', () => {
  // 118 drawn rows whose numbers have gaps: T1..T113, then T116/118/119/121/124.
  const gappy = Array.from({ length: 118 }, (_, i) => ({
    index: i < 113 ? i + 1 : [116, 118, 119, 121, 124][i - 113]
  }))

  it('anchors T113 on its ROW (112 of 118), not on its number (113 of 124)', () => {
    const [got] = pinAnchors([pin(1, 113)], gappy)
    expect(got.frac).toBeCloseTo(112 / 118, 12)
    expect(got.frac).not.toBeCloseTo(113 / 124, 6)
  })

  it('anchors the last drawn row by position, whatever number it carries', () => {
    const [got] = pinAnchors([pin(2, 124)], gappy)
    expect(got.frac).toBeCloseTo(117 / 118, 12)
    expect(got.frac).not.toBe(1) // 1 is the live tail, not the newest checkpoint
  })

  it('leaves the last 1/n of the bar to the live tail', () => {
    const [got] = pinAnchors([pin(1, 10)], rowsOf(10))
    expect(got.frac).toBe(0.9)
  })
})

/**
 * Tinker's review, both HIGHs. Each one is a claim my own comment made and my
 * own code contradicted, so each gets a guard that fails on the code, not on
 * the comment.
 */
describe('a pin is tappable, and it never covers the thumb', () => {
  it('stops the pointer before the bar can capture it', () => {
    // .cr-ckpt-mini's onPointerDown calls setPointerCapture, which retargets the
    // click to the bar. Without this the pin renders, looks right, and does
    // nothing — a real press returned onGoto null.
    const block = RAIL.slice(RAIL.indexOf('cr-ckpt-pin'), RAIL.indexOf('cr-ckpt-count'))
    expect(block).toMatch(/onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/)
  })

  it('claims NO z-index, because the thumb has none either', () => {
    // A DECLARATION, not the word: the block's comment explains the absence and
    // the first version of this guard matched its own prose.
    const block = CSS.slice(CSS.indexOf('.cr-ckpt-pin {'), CSS.indexOf('.cr-ckpt-pin.bare'))
    expect(block).not.toMatch(/^\s*z-index\s*:/m)
  })

  it('renders BEFORE the thumb, which is what actually keeps it underneath', () => {
    // Tree order decides painting for auto/0 positioned siblings, so this
    // ordering is load-bearing the moment the z-index is gone. Compare the JSX
    // SITES: both class names appear earlier in the file's structure comment,
    // and the first version of this guard compared those instead.
    const pinSite = RAIL.indexOf('`cr-ckpt-pin${')
    const thumbSite = RAIL.indexOf('className="cr-ckpt-here"')
    expect(pinSite).toBeGreaterThan(-1)
    expect(thumbSite).toBeGreaterThan(-1)
    expect(pinSite).toBeLessThan(thumbSite)
  })

  it('leaves light chrome from repainting the current pin’s label', () => {
    // (0,3,0) on-cream beat (0,2,0) .current and dropped it to 1.86:1.
    expect(CSS).toMatch(/\.cr-ckpt-rail\.on-cream \.cr-ckpt-pin:not\(\.current\)/)
  })
})

describe('the reserved pin lane (R18) survives in the stylesheet', () => {

  it('fits inside the 30px rail: right 11 + width 19', () => {
    const block = CSS.slice(CSS.indexOf('.cr-ckpt-pin {'), CSS.indexOf('.cr-ckpt-pin.bare'))
    expect(block).toMatch(/right: 11px;/)
    expect(block).toMatch(/width: 19px;/)
  })

  it('keeps the reveal out of the lane at 32px', () => {
    const roster = readFileSync(join(__dirname, '../src/renderer/src/agent-roster.css'), 'utf8')
    const lanes = roster.match(/right: 32px;/g) ?? []
    expect(lanes.length).toBe(2) // .cr-ckpt-list AND .cr-ckpt-scrub-preview
  })

  it('dims pins under the dragging thumb rather than fighting it', () => {
    expect(CSS).toMatch(/\.cr-ckpt-rail\.dragging \.cr-ckpt-pin/)
  })
})
