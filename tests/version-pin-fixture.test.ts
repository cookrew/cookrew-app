import { describe, expect, it } from 'vitest'
import fixture from './fixtures/version-pins.json'
import {
  PIN_CONTRACT_VERSION,
  pinAnchors,
  pinFraction,
  pinLabel,
  railMarkers,
  type RailRow,
  type VersionPinRecord
} from '../src/shared/version-pin'

/**
 * The fixture is a published contract — Fresco renders the rail marker from it
 * and Magpie asserts B2 against it — so it must never drift from the module it
 * claims to describe. This is the tripwire: change the contract and the
 * fixture's baked expectations fail here, not in someone else's branch.
 */

/** Rebuild the 118-row non-contiguous ledger the fixture describes. */
function nonContiguousRows(): RailRow[] {
  const rows: RailRow[] = []
  for (let i = 1; i <= 113; i++) rows.push({ index: i })
  for (const index of [116, 118, 119, 121, 124]) rows.push({ index })
  return rows
}

describe('version-pins fixture stays true to the contract', () => {
  it('declares the contract version the code ships', () => {
    expect(fixture.contractVersion).toBe(PIN_CONTRACT_VERSION)
  })

  it('contiguous: anchors match what pinAnchors derives', () => {
    const { rows, pins, anchors } = fixture.contiguous
    expect(pinAnchors(pins as VersionPinRecord[], rows)).toEqual(anchors)
  })

  it('contiguous: labels match pinLabel across all three label classes', () => {
    expect(
      fixture.contiguous.labels.map((l) => ({ version: l.version, ...pinLabel(l.version) }))
    ).toEqual(fixture.contiguous.labels)
    const classes = new Set(
      fixture.contiguous.labels.map((l) =>
        !l.labelled ? 'none' : l.text.startsWith('V') ? 'v-prefixed' : 'bare'
      )
    )
    expect(classes).toEqual(new Set(['v-prefixed', 'bare', 'none']))
  })
})

describe('version-pins fixture — the R17 non-contiguous regression', () => {
  const rows = nonContiguousRows()
  const nc = fixture.nonContiguous

  it('rebuilds the ledger the fixture describes', () => {
    expect(rows).toHaveLength(nc.rowCount)
    expect(rows[rows.length - 1].index).toBe(nc.lastIndex)
    // The property that makes this ledger interesting at all.
    expect(nc.rowCount).not.toBe(nc.lastIndex)
  })

  it('anchors each pin at its RENDER position, matching the fixture exactly', () => {
    for (const e of nc.expected) {
      const pin = nc.pins.find((p) => p.version === e.version) as VersionPinRecord
      expect(rows.findIndex((r) => r.index === pin.atIndex)).toBe(e.renderPosition)
      expect(pinFraction(pin.atIndex, rows)).toBeCloseTo(e.frac, 12)
    }
  })

  it('does NOT land where the turn number implies — the drift R17 names', () => {
    for (const e of nc.expected) {
      const pin = nc.pins.find((p) => p.version === e.version) as VersionPinRecord
      const frac = pinFraction(pin.atIndex, rows) as number
      // The old formula's answer, recorded so the regression is legible.
      expect(pin.atIndex / nc.lastIndex).toBeCloseTo(e.wrongTurnNumberFrac, 12)
      expect(frac).not.toBeCloseTo(e.wrongTurnNumberFrac, 4)
    }
  })

  it('omits a pin naming a turn number the gaps swallowed', () => {
    expect(rows.some((r) => r.index === nc.undrawn.atIndex)).toBe(false)
    expect(pinFraction(nc.undrawn.atIndex, rows)).toBe(nc.undrawn.frac)
  })
})

describe('version-pins fixture — the F6 co-location case', () => {
  it('puts the turn row, the compact marker and the pin on one frac', () => {
    const { rows, checkpoint, frac } = fixture.coLocated
    const markers = railMarkers({
      rows,
      traceMarkers: [{ kind: 'compact', afterIndex: checkpoint }],
      pins: [{ version: 3, atIndex: checkpoint, scrollLine: 0, cutAt: 1 }]
    })
    const at = markers.filter((m) => m.frac === frac)
    expect(new Set(at.map((m) => m.class))).toEqual(new Set(['turn', 'trace', 'pin']))
  })
})

describe('version-pins fixture — the no-rows case', () => {
  it('omits pins rather than guessing them onto the rail', () => {
    expect(pinAnchors(fixture.contiguous.pins as VersionPinRecord[], fixture.empty.rows)).toEqual(
      fixture.empty.anchors
    )
  })
})
