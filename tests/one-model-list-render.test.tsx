// ONE MODEL LIST, DRAWN (owner 2026-11-04): the live chip shows one MDL dial
// for model and route, and the new agent's chip offers the same rows.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TuneRail } from '../src/renderer/src/nodes/TuneRail'
import { ModelList, type ModelDialProps } from '../src/renderer/src/nodes/ModelDial'
import { NewAgentTune, newAgentLabel, type NewAgentGateway } from '../src/renderer/src/prompt/NewAgentTune'
import { offeredPick } from '../src/renderer/src/prompt/launch-pref'
import { tuneRailView, type AgentTuningState } from '../src/shared/agent-tuning'
import { launchOffer } from '../src/shared/launch-tune'
import { modelRows } from '../src/shared/model-pick'

const CHOICES = ['direct', 'group/smart', 'claude/claude-sonnet-5-5', 'claude/claude-opus-5-5', 'auto/gpt-6-luna']
const state: AgentTuningState = {
  harness: 'claude',
  knobs: ['model', 'effort', 'route'],
  records: ['model', 'effort'],
  tuning: { model: 'claude/claude-opus-5-5', effort: 'high', at: 10 },
  asks: [],
  caveat: null,
  choices: { route: CHOICES }
}
const view = tuneRailView({ state, phase: 'idle', remote: false })!
const model = (over: Partial<ModelDialProps> = {}): ModelDialProps => ({
  rows: modelRows(CHOICES),
  current: 'claude/claude-opus-5-5',
  reading: 'claude/claude-opus-5-5',
  ask: null,
  turn: null,
  note: null,
  open: false,
  onOpen: () => {},
  onPick: () => {},
  ...over
})
const route = { state: null, choices: CHOICES, open: false, onOpen: () => {}, onPick: () => {} }

describe('the live chip', () => {
  it('draws one MDL dial and no RTE when given the one list', () => {
    const html = renderToStaticMarkup(<TuneRail view={view} open={null} onOpen={() => {}} onTurn={() => {}} error={null} route={route} model={model()} menu />)
    expect(html.match(/data-knob="model"/g)).toHaveLength(1)
    expect(html).not.toContain('data-knob="route"')
    expect(html).toContain('claude-opus-5-5')
    expect(html).toContain('data-knob="effort"')
  })

  it('keeps the old rows where there is no one list', () => {
    const html = renderToStaticMarkup(<TuneRail view={view} open={null} onOpen={() => {}} onTurn={() => {}} error={null} route={route} menu />)
    expect(html).toContain('data-knob="route"')
  })

  it('opens onto the sections and marks the pending pick', () => {
    const html = renderToStaticMarkup(
      <TuneRail view={view} open={null} onOpen={() => {}} onTurn={() => {}} error={null} route={route} menu model={model({ open: true, ask: { asked: 'group/smart', outcome: 'pending' } })} />
    )
    const order = ['CLAUDE', 'GROUPS', 'OTHER PROVIDERS', 'DIRECT'].map((s) => html.indexOf(s))
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]))).toBe(true)
    expect(html).toContain('→ smart')
    expect(html).toMatch(/cr-tune-row asked group[^>]*>group\/smart</)
    expect(html).toContain('direct · opus')
  })
})

describe("the new agent's chip", () => {
  const offer = launchOffer('claude')!
  const gateway: NewAgentGateway = {
    ids: CHOICES,
    models: [{ id: 'group/smart', levels: ['low', 'medium', 'high'] }, { id: 'claude/claude-opus-5-5', levels: [] }],
    defaultModel: 'claude/claude-opus-5-5'
  }

  it('names what the default route runs, and the pick it holds', () => {
    expect(renderToStaticMarkup(<NewAgentTune offer={offer} tune={{}} onPick={() => {}} gateway={gateway} />)).toContain('claude-opus-5-5 ▾')
    expect(newAgentLabel({ model: 'group/smart', effort: 'low' }, gateway)).toBe('smart · low')
    expect(newAgentLabel({ model: 'direct:sonnet' }, gateway)).toBe('direct · sonnet')
    // no gateway: as before
    expect(renderToStaticMarkup(<NewAgentTune offer={offer} tune={{}} onPick={() => {}} />)).toContain('default ▾')
  })

  it("keeps a one-list pick the gateway lists, with an effort its model takes", () => {
    expect(offeredPick({ model: 'group/smart', effort: 'high' }, offer, gateway)).toEqual({ model: 'group/smart', effort: 'high' })
    expect(offeredPick({ model: 'group/smart', effort: 'max' }, offer, gateway)).toEqual({ model: 'group/smart' })
    expect(offeredPick({ model: 'direct:haiku', effort: 'max' }, offer, gateway)).toEqual({ model: 'direct:haiku', effort: 'max' })
    expect(offeredPick({ model: 'gone/model', effort: 'low' }, offer, gateway)).toEqual({ effort: 'low' })
    expect(offeredPick({ model: 'group/smart' }, offer, null)).toEqual({})
    expect(offeredPick({ model: 'opus', effort: 'high' }, offer, gateway)).toEqual({ model: 'opus', effort: 'high' })
  })

  it('draws its model rows with the same list as the live dial', () => {
    const html = renderToStaticMarkup(<ModelList look="menu" rows={modelRows(CHOICES)} current="direct:opus" onPick={() => {}} />)
    expect(html).toContain('role="menuitemradio" aria-checked="true" title="direct:opus"')
    expect(html).toContain('cr-prompt-menu-family cr-model-section')
  })
})
