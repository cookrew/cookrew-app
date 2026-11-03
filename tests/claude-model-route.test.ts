// A CLAUDE MODEL PICK FOLLOWS WHERE THE CARD'S TURNS GO (QA 2026-11-03).
//
// On the owner's machine ~/.claude/settings.json maps every alias to
// group/smart[1m] and outranks the env a route sets, so `--model sonnet` ran
// group/smart whether the card was routed or not. A routed card's pick now
// moves its route; a direct card's alias is sent as the gateway's id.

import { describe, expect, it } from 'vitest'
import { claudeSettingsGateway, gatewayModelFor, launchPick, newAgentPlan, withGatewayModel } from '../src/main/claude-model-route'
import { launchOffer } from '../src/shared/launch-tune'

// The live gateway's claude rows, in its own order.
const CATALOG = [
  'group/smart', 'auto/gpt-6.1-sol', 'claude/claude-haiku-5-5', 'claude/claude-sonnet-5-5', 'claude/claude-opus-5-5',
  'claude/claude-fable-5-1', 'claude/claude-opus-5', 'claude/claude-sonnet-5', 'claude/claude-opus-4-8',
  'claude/claude-opus-4-5', 'claude/claude-opus-4-5-20251101', 'claude/claude-haiku-4-5-20251001'
]

describe("the gateway's model for an alias", () => {
  it('is the newest claude model of that family, whatever order the catalog lists', () => {
    expect(gatewayModelFor('opus', CATALOG)).toBe('claude/claude-opus-5-5')
    expect(gatewayModelFor('opus', [...CATALOG].reverse())).toBe('claude/claude-opus-5-5')
    expect(gatewayModelFor('sonnet', CATALOG)).toBe('claude/claude-sonnet-5-5')
    expect(gatewayModelFor('haiku', CATALOG)).toBe('claude/claude-haiku-5-5')
    expect(gatewayModelFor('fable', CATALOG)).toBe('claude/claude-fable-5-1')
  })

  it('prefers a version over its dated snapshot, and is null when the family is absent', () => {
    expect(gatewayModelFor('opus', ['claude/claude-opus-4-5-20251101', 'claude/claude-opus-4-5'])).toBe('claude/claude-opus-4-5')
    expect(gatewayModelFor('sonnet', ['group/smart', 'auto/gpt-6.1-sol'])).toBeNull()
    expect(gatewayModelFor('opus', ['claude/claude-opus-latest'])).toBeNull()
  })
})

describe("claude's own settings point it at a gateway", () => {
  it('reads env.ANTHROPIC_BASE_URL, and nothing else', () => {
    expect(claudeSettingsGateway({ model: 'opus', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425' } })).toBe(true)
    expect(claudeSettingsGateway({ model: 'opus', env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'x' } })).toBe(false)
    expect(claudeSettingsGateway({ env: { ANTHROPIC_BASE_URL: ' ' } })).toBe(false)
    expect(claudeSettingsGateway(null)).toBe(false)
    expect(claudeSettingsGateway('{nope')).toBe(false)
  })
})

describe("a direct card's alias, spelled for the gateway at the spawn", () => {
  it("sends the gateway's id for an alias and leaves the rest of the line alone", () => {
    expect(withGatewayModel('claude --permission-mode bypassPermissions --effort low --model sonnet --resume abc', CATALOG)).toBe(
      'claude --permission-mode bypassPermissions --effort low --model claude/claude-sonnet-5-5 --resume abc'
    )
    expect(withGatewayModel('claude --model=haiku', CATALOG)).toBe('claude --model=claude/claude-haiku-5-5')
  })

  it('leaves a line with no model, an id already, or an alias the gateway lacks', () => {
    expect(withGatewayModel('claude --effort high', CATALOG)).toBe('claude --effort high')
    expect(withGatewayModel('claude --model claude/claude-opus-5-5', CATALOG)).toBe('claude --model claude/claude-opus-5-5')
    expect(withGatewayModel('claude --model opus', ['group/smart'])).toBe('claude --model opus')
  })
})

describe('a pick, for where the turns go', () => {
  const base = 'claude --permission-mode bypassPermissions --effort low'

  it('moves a routed card\'s route for a model, and leaves it no --model', () => {
    expect(launchPick({ command: `${base} --model opus`, knob: 'model', value: 'sonnet', routed: true, catalog: CATALOG })).toEqual({
      command: base,
      route: 'claude/claude-sonnet-5-5'
    })
  })

  it('refuses a routed model the gateway does not list, rather than restart onto another', () => {
    expect(launchPick({ command: base, knob: 'model', value: 'fable', routed: true, catalog: ['group/smart'] })).toEqual({
      error: 'the gateway lists no fable model to route to'
    })
  })

  it('keeps an effort as a flag, routed or not, and never touches the route', () => {
    for (const routed of [true, false]) {
      expect(launchPick({ command: base, knob: 'effort', value: 'max', routed, catalog: CATALOG })).toEqual({
        command: 'claude --permission-mode bypassPermissions --effort max'
      })
    }
  })

  it("puts a direct card's alias on its command, for the spawn to spell", () => {
    expect(launchPick({ command: base, knob: 'model', value: 'haiku', routed: false, catalog: CATALOG })).toEqual({
      command: `${base} --model haiku`
    })
  })
})

describe('the one list, in main (owner 2026-11-04)', () => {
  const base = 'claude --permission-mode bypassPermissions'
  const levelsOf = (id: string) => (id === 'group/smart' ? ['low', 'medium', 'high'] : [])

  it('routes to a gateway id and keeps the effort it runs at', () => {
    expect(launchPick({ command: `${base} --model opus`, knob: 'model', value: 'claude/claude-sonnet-5-5', routed: false, catalog: CATALOG, effort: 'high' })).toEqual({
      command: `${base} --effort high`,
      route: 'claude/claude-sonnet-5-5'
    })
  })

  it('goes direct with an alias, from a routed card', () => {
    expect(launchPick({ command: `${base} --effort low`, knob: 'model', value: 'direct:haiku', routed: true, catalog: CATALOG })).toEqual({
      command: `${base} --effort low --model haiku`,
      route: 'direct'
    })
  })

  it("lets an effort go when the new model does not take it, and refuses an id outside the catalog", () => {
    expect(launchPick({ command: `${base} --effort max`, knob: 'model', value: 'group/smart', routed: true, catalog: CATALOG, levelsOf })).toEqual({
      command: base,
      route: 'group/smart'
    })
    expect(launchPick({ command: base, knob: 'model', value: 'nope/model-x', routed: true, catalog: CATALOG })).toEqual({ error: "not in the gateway's catalog: nope/model-x" })
    expect(launchPick({ command: base, knob: 'model', value: 'direct:gpt', routed: true, catalog: CATALOG })).toMatchObject({ error: expect.stringMatching(/not a model/) })
  })

  it("keeps a bare alias's effort too (an older caller)", () => {
    expect(launchPick({ command: base, knob: 'model', value: 'sonnet', routed: true, catalog: CATALOG, effort: 'xhigh' })).toEqual({
      command: `${base} --effort xhigh`,
      route: 'claude/claude-sonnet-5-5'
    })
  })
})

describe("a new agent's pick from the one list", () => {
  const offer = launchOffer('claude')
  it('is a route, a direct alias, or the launch line as before', () => {
    expect(newAgentPlan({ command: 'claude', tune: { model: 'group/smart', effort: 'low' }, offer, catalog: CATALOG })).toEqual({ command: 'claude --effort low', route: 'group/smart' })
    expect(newAgentPlan({ command: 'claude', tune: { model: 'direct:sonnet', effort: 'max' }, offer, catalog: CATALOG })).toEqual({ command: 'claude --model sonnet --effort max', route: 'direct' })
    expect(newAgentPlan({ command: 'claude', tune: { model: 'opus' }, offer, catalog: CATALOG })).toEqual({ command: 'claude --model opus' })
    expect(newAgentPlan({ command: 'claude', tune: { model: 'nope/x', effort: 'low' }, offer, catalog: CATALOG })).toEqual({ command: 'claude --effort low' })
  })
})
