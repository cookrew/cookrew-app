// A NEW AGENT'S MODEL AND EFFORT ride its launch flags (owner 2026-11-01): the
// prompt box picks them with nobody targeted, main appends them, nothing is
// typed into a booting pane and nothing becomes the machine's default.

import { describe, expect, it } from 'vitest'
import { cleanLaunchTune, launchCommand, launchOffer, launchTuneLabel } from '../src/shared/launch-tune'

const CLAUDE = 'claude --permission-mode bypassPermissions'

describe('who is offered a pick', () => {
  it('offers claude its aliases and effort levels', () => {
    const offer = launchOffer(CLAUDE)
    expect(offer?.model).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(offer?.effort).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('offers nothing to a harness without both flags, or to a shell', () => {
    for (const command of ['codex', 'pi', 'opencode', '', 'claudette', 'echo claude']) expect(launchOffer(command)).toBeNull()
  })
})

describe('the pick is checked before it reaches a command line', () => {
  it('keeps offered values only', () => {
    expect(cleanLaunchTune(CLAUDE, { model: 'opus', effort: 'max' })).toEqual({ model: 'opus', effort: 'max' })
    expect(cleanLaunchTune(CLAUDE, { model: 'claude-opus-4-8[1m]', effort: 'auto' })).toEqual({})
    expect(cleanLaunchTune(CLAUDE, { model: 'opus; rm -rf ~' })).toEqual({})
    expect(cleanLaunchTune(CLAUDE, { model: 3, route: 'x' })).toEqual({})
  })

  it('drops the whole pick for a harness that takes none', () => {
    expect(cleanLaunchTune('codex', { model: 'opus' })).toEqual({})
  })

  it('takes junk as no pick', () => {
    for (const raw of [null, undefined, 'opus', 42, []]) expect(cleanLaunchTune(CLAUDE, raw)).toEqual({})
  })
})

describe('the launch command', () => {
  it('appends the flags', () => {
    expect(launchCommand(CLAUDE, { model: 'sonnet', effort: 'low' })).toBe(`${CLAUDE} --model sonnet --effort low`)
    expect(launchCommand(CLAUDE, { effort: 'xhigh' })).toBe(`${CLAUDE} --effort xhigh`)
  })

  it('replaces a flag the preset already carries instead of repeating it', () => {
    expect(launchCommand('claude --model haiku --verbose', { model: 'opus' })).toBe('claude --verbose --model opus')
    expect(launchCommand('claude --effort=low', { effort: 'max' })).toBe('claude --effort max')
  })

  it('is unchanged with no pick, a bad pick, or a harness that takes none', () => {
    expect(launchCommand(CLAUDE, {})).toBe(CLAUDE)
    expect(launchCommand(CLAUDE, undefined)).toBe(CLAUDE)
    expect(launchCommand(CLAUDE, { model: 'gpt-9' })).toBe(CLAUDE)
    expect(launchCommand('codex', { model: 'opus' })).toBe('codex')
  })
})

describe('the chip reads the pick', () => {
  it('says model · effort, either alone, or nothing', () => {
    expect(launchTuneLabel({ model: 'opus', effort: 'high' })).toBe('opus · high')
    expect(launchTuneLabel({ effort: 'high' })).toBe('high')
    expect(launchTuneLabel({})).toBeNull()
  })
})
