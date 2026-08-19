import { describe, expect, it } from 'vitest'
import fixture from './fixtures/version-pins.json'
import { pinAnchors, pinLabel, type VersionPinRecord } from '../src/shared/version-pin'

/**
 * The fixture is a published contract — Fresco renders the rail marker from it
 * and Magpie asserts B2 against it — so it must never drift from the module it
 * claims to describe. This is the tripwire: change the contract and the
 * fixture's baked expectations fail here, not in someone else's branch.
 */
describe('version-pins fixture stays true to the contract', () => {
  const pins = fixture.pins as VersionPinRecord[]

  it('anchors match what pinAnchors derives from the fixture base', () => {
    expect(pinAnchors(pins, fixture.scrollBase)).toEqual(fixture.anchors)
  })

  it('labels match pinLabel for every pin, covering all three label classes', () => {
    expect(fixture.labels.map((l) => ({ version: l.version, ...pinLabel(l.version) }))).toEqual(
      fixture.labels
    )
  })

  it('exercises every label class, so a renderer cannot pass by handling one', () => {
    const classes = new Set(
      fixture.labels.map((l) => (!l.labelled ? 'none' : l.text.startsWith('V') ? 'v-prefixed' : 'bare'))
    )
    expect(classes).toEqual(new Set(['v-prefixed', 'bare', 'none']))
  })

  it('co-locates a pin with a turn diamond and a compact marker (the F6 case)', () => {
    const shared = fixture.coLocated.turnIndexAtFrac.frac
    expect(fixture.coLocated.traceMarkerAtFrac.frac).toBe(shared)
    expect(fixture.anchors.some((a) => a.frac === shared)).toBe(true)
  })

  it('carries the no-base case, where pins are omitted rather than guessed', () => {
    expect(pinAnchors(pins, fixture.empty.scrollBase)).toEqual(fixture.empty.anchors)
  })
})
