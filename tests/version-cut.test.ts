import { describe, expect, it } from 'vitest'
import {
  cutVersionPin,
  cutTeamVersion,
  railMarkers,
  type VersionPinRecord
} from '../src/shared/version-pin'

const pin = (version: number, scrollLine: number): VersionPinRecord => ({
  version,
  scrollLine,
  cutAt: 1_700_000_000_000
})

describe('cutVersionPin — cutting a version never touches what it cut from', () => {
  it('returns a new pin at the next version', () => {
    const cut = cutVersionPin([pin(1, 100)], { scrollLine: 500, cutAt: 42 })
    expect(cut).toEqual({ version: 2, scrollLine: 500, cutAt: 42 })
  })

  it('does not mutate the pins it was given', () => {
    const pins = [pin(1, 100)]
    const before = JSON.stringify(pins)
    cutVersionPin(pins, { scrollLine: 500, cutAt: 42 })
    expect(JSON.stringify(pins)).toBe(before)
    expect(pins).toHaveLength(1)
  })

  it('carries the manifest it was published as, when it was published', () => {
    const cut = cutVersionPin([], { scrollLine: 1, cutAt: 2, manifestId: 'sha256:abc' })
    expect(cut.manifestId).toBe('sha256:abc')
  })

  it('omits manifestId entirely for an unpublished cut rather than storing null', () => {
    expect('manifestId' in cutVersionPin([], { scrollLine: 1, cutAt: 2 })).toBe(false)
  })
})

describe('cutTeamVersion — teams version ATOMICALLY (§10)', () => {
  it('gives every member the same version number', () => {
    const cut = cutTeamVersion(
      [
        { terminalId: 'a', pins: [pin(1, 10)], scrollLine: 100 },
        { terminalId: 'b', pins: [], scrollLine: 200 },
        { terminalId: 'c', pins: [pin(1, 5), pin(2, 9)], scrollLine: 300 }
      ],
      { cutAt: 7 }
    )
    expect(cut.version).toBe(3) // one past the highest ANY member has reached
    expect(cut.members.map((m) => m.pin.version)).toEqual([3, 3, 3])
  })

  it('pins each member at its OWN transcript point', () => {
    const cut = cutTeamVersion(
      [
        { terminalId: 'a', pins: [], scrollLine: 100 },
        { terminalId: 'b', pins: [], scrollLine: 250 }
      ],
      { cutAt: 7 }
    )
    expect(cut.members.map((m) => m.pin.scrollLine)).toEqual([100, 250])
  })

  it('is the tuple of its members — the version addresses the whole team', () => {
    const cut = cutTeamVersion([{ terminalId: 'a', pins: [], scrollLine: 1 }], { cutAt: 7 })
    expect(cut.members.map((m) => m.terminalId)).toEqual(['a'])
    expect(cut.members.every((m) => m.pin.version === cut.version)).toBe(true)
  })

  it('never mutates a member pin list', () => {
    const members = [{ terminalId: 'a', pins: [pin(1, 10)], scrollLine: 100 }]
    const before = JSON.stringify(members)
    cutTeamVersion(members, { cutAt: 7 })
    expect(JSON.stringify(members)).toBe(before)
  })

  it('refuses an empty team rather than minting a version nothing carries', () => {
    expect(() => cutTeamVersion([], { cutAt: 7 })).toThrow(/empty/i)
  })
})

describe('railMarkers — pins are a THIRD class sharing one anchor space', () => {
  const input = {
    scrollBase: 1000,
    turns: [{ index: 4, scrollLine: 500 }],
    traceMarkers: [{ kind: 'compact' as const, afterIndex: 4, scrollLine: 500 }],
    pins: [pin(2, 500)]
  }

  it('tags each marker with its class so a renderer never has to guess', () => {
    expect(new Set(railMarkers(input).map((m) => m.class))).toEqual(
      new Set(['turn', 'trace', 'pin'])
    )
  })

  it('places all three classes at the SAME frac for the same content (the F6 case)', () => {
    const fracs = new Set(railMarkers(input).map((m) => m.frac))
    expect(fracs).toEqual(new Set([0.5]))
  })

  it('keeps the pin label with the pin so the fan row and the marker agree', () => {
    const found = railMarkers(input).find((m) => m.class === 'pin')
    expect(found).toMatchObject({ class: 'pin', version: 2, label: 'V2', labelled: true })
  })

  it('orders by frac, oldest first, so the rail can render in one pass', () => {
    const out = railMarkers({
      scrollBase: 1000,
      turns: [{ index: 1, scrollLine: 900 }],
      traceMarkers: [],
      pins: [pin(1, 100)]
    })
    expect(out.map((m) => m.frac)).toEqual([0.1, 0.9])
  })

  it('yields nothing without a scroll base rather than stacking everything at 1', () => {
    expect(railMarkers({ ...input, scrollBase: null })).toEqual([])
  })
})
