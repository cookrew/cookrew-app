import { describe, expect, it } from 'vitest'
import {
  PIN_CONTRACT_VERSION,
  pinFraction,
  pinAnchors,
  pinLabel,
  nextVersion,
  type RailRow,
  type VersionPinRecord
} from '../src/shared/version-pin'

const pin = (version: number, atIndex: number): VersionPinRecord => ({
  version,
  atIndex,
  scrollLine: atIndex * 10,
  cutAt: 1_700_000_000_000
})

/** A contiguous ledger: array position i holds T(i+1). */
const contiguous = (n: number): RailRow[] => Array.from({ length: n }, (_, i) => ({ index: i + 1 }))

/**
 * A REAL non-contiguous ledger shape (R17): 19 of 125 look like this. Array
 * position 113 holds T113 while the last index is 124 — turn numbers have gaps,
 * so turn-number space and render space have different denominators.
 */
const nonContiguous = (): RailRow[] => {
  const rows: RailRow[] = []
  for (let i = 1; i <= 113; i++) rows.push({ index: i })
  for (const index of [116, 118, 119, 121, 124]) rows.push({ index })
  return rows
}

describe('pinFraction — R17: a pin lands on a DRAWN ROW', () => {
  it('is the row position over the row count', () => {
    expect(pinFraction(1, contiguous(10))).toBe(0)
    expect(pinFraction(6, contiguous(10))).toBe(0.5)
  })

  it('uses rows.length as the denominator, matching the focus tab exactly', () => {
    // NOT rows.length - 1. The rail's focus anchor is findIndex / rows.length,
    // and a "cleaner" denominator would put a pin half a row off the tab for
    // the same checkpoint — which is the alignment F6 gates.
    expect(pinFraction(10, contiguous(10))).toBe(0.9)
  })

  it('is null when the pin names a checkpoint that is not drawn', () => {
    // Omitted, not clamped: a V1 shown against T5 because the ledger starts at
    // T5 is a wrong version, and a wrong version is worse than an absent one.
    expect(pinFraction(99, contiguous(10))).toBeNull()
  })

  it('is null with no rows at all', () => {
    expect(pinFraction(1, [])).toBeNull()
  })
})

describe('pinFraction — the non-contiguous ledger that motivated R17', () => {
  const rows = nonContiguous()

  it('anchors T113 at its RENDER position, not at its turn number', () => {
    // Render space: position 112 of 118 rows.
    expect(pinFraction(113, rows)).toBeCloseTo(112 / 118, 12)
    // Turn-number space would have said 113/124 — the drift the ruling names.
    expect(pinFraction(113, rows)).not.toBeCloseTo(113 / 124, 4)
  })

  it('anchors the last drawn row at the last render slot, whatever its number', () => {
    expect(pinFraction(124, rows)).toBeCloseTo(117 / 118, 12)
  })

  it('drops a pin on a turn number that the gaps swallowed', () => {
    // 117 is a real-looking turn number that no row carries.
    expect(pinFraction(117, rows)).toBeNull()
  })

  it('never places two different checkpoints at the same fraction', () => {
    const fracs = rows.map((r) => pinFraction(r.index, rows))
    expect(new Set(fracs).size).toBe(rows.length)
  })
})

describe('pinAnchors — the shape Fresco renders', () => {
  it('derives {version, frac} in render space, ordered by version', () => {
    const rows = contiguous(4)
    expect(pinAnchors([pin(2, 3), pin(1, 1)], rows)).toEqual([
      { version: 1, frac: 0 },
      { version: 2, frac: 0.5 }
    ])
  })

  it('RE-derives against the live rows, so pins follow their row as it moves', () => {
    const p = [pin(1, 5)]
    expect(pinAnchors(p, contiguous(10))[0].frac).toBe(0.4)
    // Ledger grew: the same checkpoint is the same row, further up the rail.
    expect(pinAnchors(p, contiguous(20))[0].frac).toBe(0.2)
  })

  it('drops undrawn pins instead of stacking them at an edge', () => {
    expect(pinAnchors([pin(1, 999)], contiguous(10))).toEqual([])
  })

  it('is empty without rows', () => {
    expect(pinAnchors([pin(1, 1)], [])).toEqual([])
  })
})

describe('the contract is versioned so a rig knows which shape it holds', () => {
  it('is at v2 — render-position anchoring', () => {
    expect(PIN_CONTRACT_VERSION).toBe(2)
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
    expect(nextVersion([pin(1, 1), pin(3, 3)])).toBe(4)
  })
})
