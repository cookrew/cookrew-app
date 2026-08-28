import { describe, expect, it } from 'vitest'
import { presetChips, type InstalledPreset } from '../src/shared/preset-chip'

// WHOSE VERSION IS THIS? — the one question the chips-and-markers spec turns
// on, answered in peripheral vision.
//
// EXPORT gives you a violet versioned chip that is YOURS. IMPORT WITH
// AUTHORITY gives you the same chip, authored by someone else, and you are
// allowed to run it. Same chip family, same rail marker; the only difference
// is a provenance mark. Tag 3 is MINE, tag 4 is BY-@handle.
//
// The decision lives here rather than in the dock, because the dock, the gate
// sheet and the eval gates must read ONE answer — the reason this module
// exists at all.

const preset = (over: Partial<InstalledPreset> = {}): InstalledPreset => ({
  id: 'p1',
  name: 'Research',
  version: 1,
  members: ['claude'],
  entitled: true,
  ...over
})

const chipOf = (p: InstalledPreset, viewer?: { handle?: string }) =>
  presetChips([p], viewer)[0]

describe('MINE — a crew you authored', () => {
  it('is mine when nothing records an author: it never left this machine', () => {
    // The just-saved state. A preset with no author record did not come from
    // anywhere, so there is nobody else it could belong to.
    expect(chipOf(preset()).provenance).toEqual({ kind: 'mine' })
  })

  it('is mine when the author is the viewer', () => {
    expect(chipOf(preset({ authoredBy: 'drej' }), { handle: 'drej' }).provenance).toEqual({
      kind: 'mine'
    })
  })

  it('compares handles case-insensitively — @Drej and @drej are one person', () => {
    expect(chipOf(preset({ authoredBy: 'Drej' }), { handle: 'drej' }).provenance).toEqual({
      kind: 'mine'
    })
    expect(chipOf(preset({ authoredBy: ' drej ' }), { handle: 'DREJ' }).provenance).toEqual({
      kind: 'mine'
    })
  })
})

describe('BY @handle — a crew someone else authored', () => {
  it('names the author when it is not the viewer', () => {
    expect(chipOf(preset({ authoredBy: 'tinker' }), { handle: 'drej' }).provenance).toEqual({
      kind: 'theirs',
      handle: 'tinker'
    })
  })

  it('carries the handle as WRITTEN, so the tag renders the author’s own spelling', () => {
    // The comparison normalises; the label must not. Rendering BY @tinker for
    // an author who writes themselves @Tinker is a small lie about a name.
    expect(chipOf(preset({ authoredBy: 'Tinker' }), { handle: 'drej' }).provenance).toEqual({
      kind: 'theirs',
      handle: 'Tinker'
    })
  })
})

describe('when the viewer is unknown, we state the true fact and not the flattering one', () => {
  it('names the author rather than claiming the chip is yours', () => {
    // Signed out, or before accounts exist. Saying MINE here would be an
    // unverified claim of ownership; saying BY @drej is simply true, and at
    // worst redundant when the viewer IS drej. Same rule this codebase
    // reaches everywhere: cannot-verify does not resolve to the convenient
    // answer — and here the convenient answer is the one that claims property.
    expect(chipOf(preset({ authoredBy: 'drej' })).provenance).toEqual({
      kind: 'theirs',
      handle: 'drej'
    })
    expect(chipOf(preset({ authoredBy: 'drej' }), {}).provenance).toEqual({
      kind: 'theirs',
      handle: 'drej'
    })
  })

  it('still says mine for an unauthored local save, viewer or not', () => {
    // No author anywhere is not an unanswered question — it is an answered
    // one. Nothing arrived, so nothing is anyone else's.
    expect(chipOf(preset()).provenance).toEqual({ kind: 'mine' })
    expect(chipOf(preset(), { handle: 'drej' }).provenance).toEqual({ kind: 'mine' })
  })

  it('treats a blank author as no author, not as an author called ""', () => {
    expect(chipOf(preset({ authoredBy: '   ' })).provenance).toEqual({ kind: 'mine' })
  })
})

describe('provenance is orthogonal to every existing chip state', () => {
  it('does not disturb the badge ranking', () => {
    // An imported preset that is gated still leads with the lock; provenance
    // is a tag beside the badge, never a competitor for it.
    const chip = chipOf(
      preset({ authoredBy: 'tinker', entitled: false, headVersion: 3 }),
      { handle: 'drej' }
    )
    expect(chip.badge).toBe('lock')
    expect(chip.provenance).toEqual({ kind: 'theirs', handle: 'tinker' })
  })

  it('rides an update badge without changing it', () => {
    const chip = chipOf(preset({ authoredBy: 'tinker', headVersion: 2 }), { handle: 'drej' })
    expect(chip.badge).toBe('update')
    expect(chip.headVersion).toBe(2)
    expect(chip.provenance.kind).toBe('theirs')
  })

  it('is present on EVERY chip, so no caller has to handle its absence', () => {
    // An optional field would push the mine/theirs decision back out to the
    // three callers this module exists to keep in agreement.
    const chips = presetChips(
      [preset({ id: 'a' }), preset({ id: 'b', authoredBy: 'tinker' })],
      { handle: 'drej' }
    )
    expect(chips.every((c) => c.provenance !== undefined)).toBe(true)
  })

  it('leaves the existing call shape working — viewer is optional', () => {
    // presetChips(installed) has callers already; adding a required argument
    // would be a breaking change for a provenance feature.
    expect(() => presetChips([preset()])).not.toThrow()
    expect(presetChips([preset()])).toHaveLength(1)
  })
})
