import { describe, expect, it } from 'vitest'
import {
  presetChips,
  chipAction,
  presetsNeedingUpdateCheck,
  type InstalledPreset
} from '../src/shared/preset-chip'

const installed = (over: Partial<InstalledPreset> = {}): InstalledPreset => ({
  id: 'sha256:a',
  name: 'Deep Research',
  version: 2,
  members: ['Claude Code'],
  entitled: true,
  ...over
})

describe('presetChips — a third family, in the same chip grammar', () => {
  it('is single when the preset ships one agent', () => {
    const [chip] = presetChips([installed()])
    expect(chip.kind).toBe('single')
    expect(chip.sprites).toEqual(['Claude Code'])
  })

  it('is a stacked team chip when it ships more than one', () => {
    const [chip] = presetChips([installed({ members: ['Claude Code', 'Codex', 'Shell'] })])
    expect(chip.kind).toBe('team')
    expect(chip.sprites).toEqual(['Claude Code', 'Codex', 'Shell'])
  })

  it('carries the name as its label — no version in the chip text', () => {
    // The version lives on the badge and in the sheet; putting it in the label
    // would make every chip re-flow on an update.
    const [chip] = presetChips([installed({ name: 'Deep Research', version: 12 })])
    expect(chip.label).toBe('Deep Research')
  })

  it('preserves install order so the row does not reshuffle under the pointer', () => {
    const chips = presetChips([
      installed({ id: 'sha256:a', name: 'A' }),
      installed({ id: 'sha256:b', name: 'B' })
    ])
    expect(chips.map((c) => c.label)).toEqual(['A', 'B'])
  })
})

describe('presetChips — badge states', () => {
  it('wears no badge when owned and current', () => {
    expect(presetChips([installed()])[0].badge).toBe('none')
  })

  it('wears the lock when the buyer is not entitled', () => {
    expect(presetChips([installed({ entitled: false })])[0].badge).toBe('lock')
  })

  it('wears the update badge when the registry is ahead', () => {
    const [chip] = presetChips([installed({ version: 2, headVersion: 3 })])
    expect(chip.badge).toBe('update')
    expect(chip.headVersion).toBe(3)
  })

  it('does not badge a downgrade or an unchecked preset', () => {
    expect(presetChips([installed({ version: 3, headVersion: 2 })])[0].badge).toBe('none')
    expect(presetChips([installed({ version: 3 })])[0].badge).toBe('none')
  })

  it('shows the LOCK over an update — the gate outranks the offer', () => {
    // A locked preset cannot be updated into either; leading with "v3
    // available" on something you cannot run reads as a bug.
    const [chip] = presetChips([installed({ entitled: false, version: 2, headVersion: 3 })])
    expect(chip.badge).toBe('lock')
  })
})

describe('chipAction — R2: an owned chip arms placement, a locked one opens the sheet', () => {
  it('arms placement for an owned preset — the canvas click is the confirm', () => {
    expect(chipAction(presetChips([installed()])[0])).toBe('place')
  })

  it('arms placement for an owned TEAM too — no dialog before a team paste', () => {
    expect(chipAction(presetChips([installed({ members: ['a', 'b'] })])[0])).toBe('place')
  })

  it('opens the gate sheet instead of placing when locked', () => {
    expect(chipAction(presetChips([installed({ entitled: false })])[0])).toBe('gate')
  })

  it('still places when an update is available — the update is an offer, not a block', () => {
    expect(chipAction(presetChips([installed({ version: 2, headVersion: 3 })])[0])).toBe('place')
  })
})

describe('presetsNeedingUpdateCheck — R3: on dock open, never on a timer', () => {
  it('asks for every installed preset when the dock opens', () => {
    expect(presetsNeedingUpdateCheck([installed({ id: 'sha256:a' }), installed({ id: 'sha256:b' })])).toEqual([
      'sha256:a',
      'sha256:b'
    ])
  })

  it('asks nothing when nothing is installed', () => {
    expect(presetsNeedingUpdateCheck([])).toEqual([])
  })

  it('does not re-ask for a preset already checked this open', () => {
    const list = [installed({ id: 'sha256:a', headVersion: 2 }), installed({ id: 'sha256:b' })]
    expect(presetsNeedingUpdateCheck(list)).toEqual(['sha256:b'])
  })
})
