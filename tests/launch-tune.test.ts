// A NEW AGENT'S MODEL AND EFFORT ride its launch flags (owner 2026-11-01): the
// prompt box picks them with nobody targeted, main appends them, nothing is
// typed into a booting pane and nothing becomes the machine's default.
//
// Every harness that takes the flags gets the pick (owner 2026-11-01: "fill in
// the other harnesses' model and effort"): claude, codex, pi, and opencode's
// model. Each offer names its harness, which decides how the flags are spelled.

import { describe, expect, it } from 'vitest'
import { cleanLaunchTune, effortOffer, launchCommand, launchOffer, launchTuneLabel, withoutRoutedPick, type LaunchOffer } from '../src/shared/launch-tune'

const CLAUDE = 'claude --permission-mode bypassPermissions'

const CODEX: LaunchOffer = {
  harness: 'codex',
  model: ['gpt-6.1-sol', 'gpt-6-luna', 'openai/gpt-5-pro'],
  effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  effortFor: { 'gpt-6-luna': ['low', 'medium', 'high', 'xhigh', 'max'], 'openai/gpt-5-pro': ['high'] }
}
const PI: LaunchOffer = {
  harness: 'pi',
  model: ['qwen-local/qwen3.8-27b-q8', 'ifunk/k3'],
  effort: ['off'],
  effortFor: { 'ifunk/k3': ['off', 'minimal', 'low', 'medium', 'high'] }
}
const OPENCODE: LaunchOffer = { harness: 'opencode', model: ['gemini/gemini-2.5-pro', 'openai/gpt-5.2-codex'], effort: [] }

describe('who is offered a pick without asking main', () => {
  it('offers claude its aliases and effort levels', () => {
    const offer = launchOffer(CLAUDE)
    expect(offer?.harness).toBe('claude')
    expect(offer?.model).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(offer?.effort).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('leaves every other harness to main, whose catalogs are on disk', () => {
    for (const command of ['codex', 'pi', 'opencode', '', 'claudette', 'echo claude']) expect(launchOffer(command)).toBeNull()
  })
})

describe('the effort a model takes', () => {
  it("is the model's own levels when the catalog says so", () => {
    expect(effortOffer(CODEX, 'openai/gpt-5-pro')).toEqual(['high'])
    expect(effortOffer(PI, 'ifunk/k3')).toContain('high')
  })

  it("is the default model's levels with no model picked, or one the catalog says nothing about", () => {
    expect(effortOffer(CODEX, undefined)).toEqual(CODEX.effort)
    expect(effortOffer(CODEX, 'gpt-6.1-sol')).toEqual(CODEX.effort)
  })
})

describe('the pick is checked before it reaches a command line', () => {
  it('keeps offered values only', () => {
    const offer = launchOffer(CLAUDE)
    expect(cleanLaunchTune(offer, { model: 'opus', effort: 'max' })).toEqual({ model: 'opus', effort: 'max' })
    expect(cleanLaunchTune(offer, { model: 'claude-opus-4-8[1m]', effort: 'auto' })).toEqual({})
    expect(cleanLaunchTune(offer, { model: 'opus; rm -rf ~' })).toEqual({})
    expect(cleanLaunchTune(offer, { model: 3, route: 'x' })).toEqual({})
  })

  it("checks the effort against the PICKED model's levels", () => {
    expect(cleanLaunchTune(CODEX, { model: 'openai/gpt-5-pro', effort: 'low' })).toEqual({ model: 'openai/gpt-5-pro' })
    expect(cleanLaunchTune(CODEX, { model: 'gpt-6-luna', effort: 'ultra' })).toEqual({ model: 'gpt-6-luna' })
    expect(cleanLaunchTune(PI, { effort: 'high' })).toEqual({})
    expect(cleanLaunchTune(PI, { model: 'ifunk/k3', effort: 'high' })).toEqual({ model: 'ifunk/k3', effort: 'high' })
  })

  it('refuses a catalog value that could break out of a shell word', () => {
    const odd: LaunchOffer = { harness: 'codex', model: ['gpt; touch /tmp/x', "it's"], effort: ['$(id)'] }
    expect(cleanLaunchTune(odd, { model: 'gpt; touch /tmp/x', effort: '$(id)' })).toEqual({})
    expect(cleanLaunchTune(odd, { model: "it's" })).toEqual({})
  })

  it('drops the whole pick when there is no offer', () => {
    expect(cleanLaunchTune(null, { model: 'opus' })).toEqual({})
  })

  it('takes junk as no pick', () => {
    for (const raw of [null, undefined, 'opus', 42, []]) expect(cleanLaunchTune(launchOffer(CLAUDE), raw)).toEqual({})
  })
})

describe('the launch command', () => {
  it('appends claude its flags', () => {
    expect(launchCommand(CLAUDE, { model: 'sonnet', effort: 'low' })).toBe(`${CLAUDE} --model sonnet --effort low`)
    expect(launchCommand(CLAUDE, { effort: 'xhigh' })).toBe(`${CLAUDE} --effort xhigh`)
  })

  it('spells codex its own way: -m, and the effort as a config override', () => {
    expect(launchCommand('codex', { model: 'gpt-6-luna', effort: 'high' }, CODEX)).toBe('codex -m gpt-6-luna -c model_reasoning_effort=high')
    expect(launchCommand('codex --model gpt-5 -c model_reasoning_effort=low --yolo', { model: 'gpt-6-luna', effort: 'max' }, CODEX)).toBe(
      'codex --yolo -m gpt-6-luna -c model_reasoning_effort=max'
    )
  })

  it('spells pi its own way: --model provider/id and --thinking', () => {
    expect(launchCommand('pi', { model: 'ifunk/k3', effort: 'medium' }, PI)).toBe('pi --model ifunk/k3 --thinking medium')
    expect(launchCommand('qwen-pi --thinking off', { model: 'ifunk/k3', effort: 'low' }, PI)).toBe('qwen-pi --model ifunk/k3 --thinking low')
  })

  it('gives opencode its model and nothing else', () => {
    expect(launchCommand('opencode', { model: 'gemini/gemini-2.5-pro', effort: 'high' }, OPENCODE)).toBe('opencode --model gemini/gemini-2.5-pro')
    expect(launchCommand('opencode -m openai/gpt-5.2-codex', { model: 'gemini/gemini-2.5-pro' }, OPENCODE)).toBe('opencode --model gemini/gemini-2.5-pro')
  })

  it('replaces a flag the preset already carries instead of repeating it', () => {
    expect(launchCommand('claude --model haiku --verbose', { model: 'opus' })).toBe('claude --verbose --model opus')
    expect(launchCommand('claude --effort=low', { effort: 'max' })).toBe('claude --effort max')
  })

  it('is unchanged with no pick, a bad pick, or no offer', () => {
    expect(launchCommand(CLAUDE, {})).toBe(CLAUDE)
    expect(launchCommand(CLAUDE, undefined)).toBe(CLAUDE)
    expect(launchCommand(CLAUDE, { model: 'gpt-9' })).toBe(CLAUDE)
    expect(launchCommand('codex', { model: 'opus' })).toBe('codex')
    expect(launchCommand('codex', { model: 'opus' }, null)).toBe('codex')
  })
})

describe('the chip reads the pick', () => {
  it('says model · effort, either alone, or nothing', () => {
    expect(launchTuneLabel({ model: 'opus', effort: 'high' })).toBe('opus · high')
    expect(launchTuneLabel({ effort: 'high' })).toBe('high')
    expect(launchTuneLabel({})).toBeNull()
  })
})

// Review 2026-11-02: a routed card's route args come after the command, and
// codex's -m outranks the route's -c model=.
describe('a routed card gives the pick way to its route', () => {
  it("drops codex's and opencode's model, pi's model and thinking, and keeps claude's", () => {
    expect(withoutRoutedPick('codex -m gpt-6-luna -c model_reasoning_effort=high resume abc', 'codex')).toBe('codex -c model_reasoning_effort=high resume abc')
    expect(withoutRoutedPick('opencode --model gemini/gemini-2.5-pro --session ses_1', 'opencode')).toBe('opencode --session ses_1')
    expect(withoutRoutedPick('pi --model ifunk/k3 --thinking high', 'pi')).toBe('pi')
    expect(withoutRoutedPick('claude --model opus --effort high', 'claude')).toBe('claude --model opus --effort high')
    expect(withoutRoutedPick('zsh', null)).toBe('zsh')
  })
})

describe('a catalog slug named like an object key', () => {
  it('reads no prototype member as its levels', () => {
    const offer: LaunchOffer = { harness: 'codex', model: ['constructor'], effort: ['low'], effortFor: {} }
    expect(effortOffer(offer, 'constructor')).toEqual(['low'])
    expect(cleanLaunchTune(offer, { model: 'constructor', effort: 'low' })).toEqual({ model: 'constructor', effort: 'low' })
  })
})
