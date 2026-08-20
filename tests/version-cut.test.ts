import { describe, expect, it } from 'vitest'
import {
  cutVersionPin,
  cutTeamVersion,
  railMarkers,
  type VersionPinRecord
} from '../src/shared/version-pin'

const pin = (version: number, atIndex: number): VersionPinRecord => ({
  version,
  atIndex,
  scrollLine: atIndex * 10,
  cutAt: 1_700_000_000_000
})

describe('cutVersionPin — cutting a version never touches what it cut from', () => {
  it('returns a new pin at the next version', () => {
    const cut = cutVersionPin([pin(1, 3)], { atIndex: 7, scrollLine: 500, cutAt: 42 })
    expect(cut).toEqual({ version: 2, atIndex: 7, scrollLine: 500, cutAt: 42 })
  })

  it('does not mutate the pins it was given', () => {
    const pins = [pin(1, 3)]
    const before = JSON.stringify(pins)
    cutVersionPin(pins, { atIndex: 7, scrollLine: 500, cutAt: 42 })
    expect(JSON.stringify(pins)).toBe(before)
    expect(pins).toHaveLength(1)
  })

  it('carries the manifest it was published as, when it was published', () => {
    const cut = cutVersionPin([], { atIndex: 1, scrollLine: 1, cutAt: 2, manifestId: 'sha256:abc' })
    expect(cut.manifestId).toBe('sha256:abc')
  })

  it('omits manifestId entirely for an unpublished cut rather than storing null', () => {
    expect('manifestId' in cutVersionPin([], { atIndex: 1, scrollLine: 1, cutAt: 2 })).toBe(false)
  })
})

describe('cutTeamVersion — teams version ATOMICALLY (§10)', () => {
  it('gives every member the same version number', () => {
    const cut = cutTeamVersion(
      [
        { terminalId: 'a', pins: [pin(1, 2)], atIndex: 4, scrollLine: 100 },
        { terminalId: 'b', pins: [], atIndex: 6, scrollLine: 200 },
        { terminalId: 'c', pins: [pin(1, 1), pin(2, 2)], atIndex: 9, scrollLine: 300 }
      ],
      { cutAt: 7 }
    )
    expect(cut.version).toBe(3) // one past the highest ANY member has reached
    expect(cut.members.map((m) => m.pin.version)).toEqual([3, 3, 3])
  })

  it('pins each member at its OWN transcript point', () => {
    const cut = cutTeamVersion(
      [
        { terminalId: 'a', pins: [], atIndex: 3, scrollLine: 100 },
        { terminalId: 'b', pins: [], atIndex: 8, scrollLine: 250 }
      ],
      { cutAt: 7 }
    )
    expect(cut.members.map((m) => m.pin.atIndex)).toEqual([3, 8])
  })

  it('is the tuple of its members — the version addresses the whole team', () => {
    const cut = cutTeamVersion([{ terminalId: 'a', pins: [], atIndex: 1, scrollLine: 1 }], { cutAt: 7 })
    expect(cut.members.map((m) => m.terminalId)).toEqual(['a'])
    expect(cut.members.every((m) => m.pin.version === cut.version)).toBe(true)
  })

  it('never mutates a member pin list', () => {
    const members = [{ terminalId: 'a', pins: [pin(1, 2)], atIndex: 4, scrollLine: 100 }]
    const before = JSON.stringify(members)
    cutTeamVersion(members, { cutAt: 7 })
    expect(JSON.stringify(members)).toBe(before)
  })

  it('refuses an empty team rather than minting a version nothing carries', () => {
    expect(() => cutTeamVersion([], { cutAt: 7 })).toThrow(/empty/i)
  })
})

describe('railMarkers — all three classes in ONE space (R17)', () => {
  const rows = [{ index: 1 }, { index: 2 }, { index: 4 }, { index: 7 }]
  const input = {
    rows,
    traceMarkers: [{ kind: 'compact', afterIndex: 4 }],
    pins: [pin(2, 4)]
  }

  it('tags each marker with its class so a renderer never has to guess', () => {
    expect(new Set(railMarkers(input).map((m) => m.class))).toEqual(
      new Set(['turn', 'trace', 'pin'])
    )
  })

  it('places all three classes at the SAME frac for the same checkpoint (F6)', () => {
    // T4 is drawn at array position 2 of 4 rows → 0.5, whatever its number.
    const atT4 = railMarkers(input).filter((m) => m.frac === 0.5)
    expect(new Set(atT4.map((m) => m.class))).toEqual(new Set(['turn', 'trace', 'pin']))
  })

  it('does NOT place them where the turn number implies — the drift being fixed', () => {
    // Turn-number space would put T4 at 4/7 ≈ 0.571 rather than 0.5.
    expect(railMarkers(input).every((m) => m.frac !== 4 / 7)).toBe(true)
  })

  it('keeps the pin label with the pin so the fan row and the marker agree', () => {
    const found = railMarkers(input).find((m) => m.class === 'pin')
    expect(found).toMatchObject({ class: 'pin', version: 2, label: 'V2', labelled: true })
  })

  it('orders by frac, oldest first, so the rail can render in one pass', () => {
    const out = railMarkers({ rows, traceMarkers: [], pins: [pin(1, 7)] })
    expect(out.map((m) => m.frac)).toEqual([0, 0.25, 0.5, 0.75, 0.75])
  })

  it('drops a marker whose checkpoint is not drawn instead of inventing a row', () => {
    const out = railMarkers({
      rows,
      traceMarkers: [{ kind: 'compact', afterIndex: 99 }],
      pins: [pin(1, 99)]
    })
    expect(out.every((m) => m.class === 'turn')).toBe(true)
  })

  it('yields nothing with no rows rather than stacking everything at an edge', () => {
    expect(railMarkers({ ...input, rows: [] })).toEqual([])
  })
})
