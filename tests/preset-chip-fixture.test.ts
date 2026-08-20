import { describe, expect, it } from 'vitest'
import fixture from './fixtures/preset-chips.json'
import {
  chipAction,
  presetChips,
  presetsNeedingUpdateCheck,
  type InstalledPreset
} from '../src/shared/preset-chip'

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

  it('covers every badge state, so a renderer cannot pass by handling one', () => {
    expect(new Set(expectedChips.map((c) => c.badge))).toEqual(new Set(['none', 'lock', 'update']))
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
