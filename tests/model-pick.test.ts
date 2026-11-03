// ONE MODEL LIST (owner 2026-11-04): the live chip's MDL and RTE rows were one
// fact twice, and the new agent's chip had no route at all. Both read this.

import { describe, expect, it } from 'vitest'
import { currentModelValue, effortLevelsFor, keptEffort, modelAskState, modelChipText, modelRows, parseModelPick } from '../src/shared/model-pick'

const CHOICES = ['direct', 'group/smart', 'auto/gpt-6.1-sol', 'claude/claude-haiku-5-5', 'claude/claude-opus-5-5', 'has space/x']

describe('the list', () => {
  it('is claude, then groups, then other providers, then direct by alias', () => {
    const rows = modelRows(CHOICES, ['opus', 'sonnet'])
    expect(rows.map((r) => `${r.section}:${r.value}`)).toEqual([
      'claude:claude/claude-haiku-5-5',
      'claude:claude/claude-opus-5-5',
      'group:group/smart',
      'other:auto/gpt-6.1-sol',
      'direct:direct:opus',
      'direct:direct:sonnet'
    ])
    expect(rows.at(-1)?.label).toBe('direct · sonnet')
  })
})

describe('a pick', () => {
  it('is a gateway id, direct with an alias, or an older bare alias', () => {
    expect(parseModelPick('claude/claude-opus-5-5')).toEqual({ route: 'claude/claude-opus-5-5' })
    expect(parseModelPick('direct:sonnet')).toEqual({ route: 'direct', alias: 'sonnet' })
    expect(parseModelPick('haiku')).toEqual({ alias: 'haiku' })
  })

  it('refuses anything a list would not offer', () => {
    for (const bad of ['direct:gpt', 'claude/opus; rm -rf', 'opus-ish', '', 'direct:']) expect(parseModelPick(bad)).toBeNull()
  })

  it('reads short on the chip', () => {
    expect(modelChipText('claude/claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(modelChipText('direct:opus')).toBe('direct · opus')
  })
})

describe('where the card stands', () => {
  const reading = (model: string | null, at = 10) => ({ model, effort: 'high', at })

  it('is its route when routed, its alias when direct, unknown before the route is read', () => {
    expect(currentModelValue('group/smart', reading('claude-opus-5-5'))).toBe('group/smart')
    expect(currentModelValue('direct', reading('claude/claude-sonnet-5-5'))).toBe('direct:sonnet')
    expect(currentModelValue('direct', reading('group/smart'))).toBeNull()
    expect(currentModelValue(null, reading('claude-opus-5-5'))).toBeNull()
  })

  it('shows an ask as pending until a reply lands, then settled or refused', () => {
    const asks = [{ knob: 'model' as const, value: 'claude/claude-sonnet-5-5', at: 20 }]
    expect(modelAskState(asks, 'claude/claude-sonnet-5-5', reading('x', 10))).toEqual({ asked: 'claude/claude-sonnet-5-5', outcome: 'pending' })
    expect(modelAskState(asks, 'claude/claude-sonnet-5-5', reading('x', 30))).toBeNull()
    expect(modelAskState(asks, 'claude/claude-opus-5-5', reading('x', 30))).toEqual({ asked: 'claude/claude-sonnet-5-5', outcome: 'refused' })
    // an older caller's alias settles on the same family
    expect(modelAskState([{ knob: 'model', value: 'sonnet', at: 20 }], 'direct:sonnet', reading('x', 30))).toBeNull()
    expect(modelAskState([{ knob: 'effort', value: 'low', at: 20 }], null, null)).toBeNull()
  })
})

describe('effort, across a model change', () => {
  const MODELS = [{ id: 'auto/gpt-6-luna', levels: ['low', 'medium', 'high', 'xhigh'] }, { id: 'claude/claude-opus-5-5', levels: [] }]

  it("offers the model's catalog levels, else claude's own", () => {
    expect(effortLevelsFor('auto/gpt-6-luna', MODELS)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(effortLevelsFor('claude/claude-opus-5-5', MODELS)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortLevelsFor('direct:opus', MODELS)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('keeps the effort where the new model takes it, else lets it go', () => {
    expect(keptEffort('high', ['low', 'high'])).toBe('high')
    expect(keptEffort('max', ['low', 'high'])).toBeNull()
    expect(keptEffort(null, ['low'])).toBeNull()
  })
})
