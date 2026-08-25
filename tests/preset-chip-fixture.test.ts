import { describe, expect, it } from 'vitest'
import fixture from './fixtures/preset-chips.json'
import {
  chipAction,
  chipBadgeAction,
  presetChips,
  presetsNeedingUpdateCheck,
  type InstalledPreset
} from '../src/shared/preset-chip'
import { shouldRaiseRotationSheet } from '../src/shared/preset-rotation'

/** Strip the `_` annotations the fixture carries for its human readers. */
const installed = fixture.installed.map(({ _, ...rest }) => rest) as InstalledPreset[]
const expectedChips = fixture.chips.map((c) => ({ ...c }))

describe('preset-chips fixture stays true to the chip model', () => {
  it('derives exactly the chips the fixture claims', () => {
    expect(presetChips(installed)).toEqual(expectedChips)
  })

  it('derives exactly the actions the fixture claims (R2)', () => {
    expect(presetChips(installed).map(chipAction)).toEqual(fixture.actions)
  })

  it('asks for exactly the unanswered presets on dock open (R3)', () => {
    expect(presetsNeedingUpdateCheck(installed)).toEqual(fixture.updateCheckOnOpen.ids)
  })

  it('derives exactly the badge actions the fixture claims (R20)', () => {
    expect(presetChips(installed).map(chipBadgeAction)).toEqual(fixture.badgeActions.actions)
  })

  it('raises the rotation sheet for exactly the unseen rotations (R20: once as a sheet)', () => {
    const raising = installed.filter((p) => shouldRaiseRotationSheet(p.keyChanged)).map((p) => p.id)
    expect(raising).toEqual(fixture.rotationSheetOnOpen.ids)
  })

  it('covers every badge state, so a renderer cannot pass by handling one', () => {
    expect(new Set(expectedChips.map((c) => c.badge))).toEqual(
      new Set(['none', 'lock', 'key-changed', 'update'])
    )
  })

  it('never offers an update on a rotated preset — that update is the refused one', () => {
    const rotated = expectedChips.filter((c) => c.badge === 'key-changed')
    expect(rotated.length).toBeGreaterThan(0)
    for (const chip of rotated) expect(chip).not.toHaveProperty('headVersion')
    // ...including the one whose registry version really is ahead.
    const ahead = installed.find((p) => p.keyChanged !== undefined && (p.headVersion ?? 0) > p.version)
    expect(ahead).toBeDefined()
    expect(presetChips([ahead as InstalledPreset])[0].badge).toBe('key-changed')
  })

  it('covers both chip kinds, gated and owned', () => {
    expect(new Set(expectedChips.map((c) => c.kind))).toEqual(new Set(['single', 'team']))
    expect(new Set(fixture.actions)).toEqual(new Set(['place', 'gate']))
  })

  it('includes the lock-outranks-update case', () => {
    const both = installed.find((p) => !p.entitled && (p.headVersion ?? 0) > p.version)
    expect(both).toBeDefined()
    const chip = presetChips([both as InstalledPreset])[0]
    expect(chip.badge).toBe('lock')
  })
})
