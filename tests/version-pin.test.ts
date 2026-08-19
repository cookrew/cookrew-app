import { describe, expect, it } from 'vitest'
import {
  pinFraction,
  pinAnchors,
  pinLabel,
  nextVersion,
  type VersionPinRecord
} from '../src/shared/version-pin'
import { markerFraction } from '../src/renderer/src/checkpoint-sync'

const pin = (version: number, scrollLine: number): VersionPinRecord => ({
  version,
  scrollLine,
  cutAt: 1_700_000_000_000
})

describe('pinFraction — pins share the rail tick anchor space', () => {
  it('agrees with markerFraction for the same position', () => {
    // A pin cut at scrollLine L sits where a scroll to depth (base − L) sits.
    const base = 1000
    const line = 400
    expect(pinFraction(line, base)).toBeCloseTo(markerFraction(base - line, base), 10)
  })

  it('puts a pin cut at the live bottom at 1 and the oldest at 0', () => {
    expect(pinFraction(1000, 1000)).toBe(1)
    expect(pinFraction(0, 1000)).toBe(0)
  })

  it('clamps rather than escaping the rail when history is shorter than the pin', () => {
    // scrollBase can shrink (a session cleared out from under an old pin).
    expect(pinFraction(2000, 1000)).toBe(1)
    expect(pinFraction(-50, 1000)).toBe(0)
  })

  it('is 1 when there is no scroll base to measure against', () => {
    expect(pinFraction(400, null)).toBe(1)
    expect(pinFraction(400, 0)).toBe(1)
  })
})

describe('pinAnchors — the shape Fresco renders', () => {
  it('derives {version, frac} and never carries a stored fraction', () => {
    const anchors = pinAnchors([pin(1, 200), pin(2, 800)], 1000)
    expect(anchors).toEqual([
      { version: 1, frac: 0.2 },
      { version: 2, frac: 0.8 }
    ])
  })

  it('RE-derives against the live base, so pins do not drift as history grows', () => {
    // The same pin, after the session has grown: its fraction must move up the
    // rail, exactly as a tick for the same content does. A stored frac would
    // freeze it and slide it off its own transcript point.
    const p = [pin(1, 500)]
    expect(pinAnchors(p, 1000)[0].frac).toBe(0.5)
    expect(pinAnchors(p, 2000)[0].frac).toBe(0.25)
  })

  it('orders by version regardless of input order', () => {
    const anchors = pinAnchors([pin(3, 900), pin(1, 100), pin(2, 500)], 1000)
    expect(anchors.map((a) => a.version)).toEqual([1, 2, 3])
  })

  it('is empty without a base rather than guessing positions', () => {
    expect(pinAnchors([pin(1, 500)], null)).toEqual([])
  })
})

describe('pinLabel — R8: a wrong version is worse than an absent one', () => {
  it('labels V1..V9', () => {
    expect(pinLabel(1)).toEqual({ text: 'V1', labelled: true })
    expect(pinLabel(9)).toEqual({ text: 'V9', labelled: true })
  })

  it('drops the V for 10..99 and shows the bare number', () => {
    expect(pinLabel(10)).toEqual({ text: '10', labelled: true })
    expect(pinLabel(99)).toEqual({ text: '99', labelled: true })
  })

  it('shows no label at all from 100 — the exact version goes to the fan row', () => {
    expect(pinLabel(100)).toEqual({ text: '', labelled: false })
    expect(pinLabel(1234)).toEqual({ text: '', labelled: false })
  })

  it('never invents a label for a nonsense version', () => {
    expect(pinLabel(0).labelled).toBe(false)
    expect(pinLabel(-1).labelled).toBe(false)
  })
})

describe('nextVersion — pins are monotonic and never reused', () => {
  it('starts at 1', () => {
    expect(nextVersion([])).toBe(1)
  })
  it('continues past the highest, not the count', () => {
    // A deleted pin must not hand its number to a later cut: versions are
    // addressable identity, so reuse would alias two different transcripts.
    expect(nextVersion([pin(1, 10), pin(3, 30)])).toBe(4)
  })
})
