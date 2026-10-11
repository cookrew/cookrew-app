// R2 · THE RTE DIAL, PAINTED.
//
// A third chip beside MDL and EFF in the same language: the route the card
// asked for, this turn's model · tokens · cost under it, "applies on restart"
// when the pick waits for the next boot, "gateway offline · direct" when the
// gateway is gone. The list opens with direct first, then groups, then models.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TuneRail, type RouteDialProps } from '../src/renderer/src/nodes/TuneRail'
import { tuneRailView, type AgentTuningState, type TuneRailView } from '../src/shared/agent-tuning'
import { cardRouteFixture, localTurnFixture, routeFixture } from '../src/shared/route-fixture'
import { GATEWAY_DOWN_NOW, routeChoices, routeDialLines } from '../src/shared/route-view'

const T0 = 1_759_000_000_000

function rail(knobs: AgentTuningState['knobs'] = ['model', 'effort']): TuneRailView {
  const state: AgentTuningState = {
    harness: 'claude',
    knobs,
    records: ['model', 'effort'],
    tuning: { model: 'claude-opus-5', effort: 'high', at: T0 },
    asks: [],
    caveat: null
  }
  const built = tuneRailView({ state, phase: 'idle', remote: false })
  if (built === null) throw new Error('this fixture must draw a rail')
  return built
}

const CHOICES = routeChoices(routeFixture('online').models)

function paint(route: RouteDialProps | null, knobs?: AgentTuningState['knobs']): string {
  return renderToStaticMarkup(<TuneRail view={rail(knobs)} open={null} onOpen={() => {}} onTurn={() => {}} error={null} route={route} />)
}

const dial = (over: Partial<RouteDialProps> = {}): RouteDialProps => ({
  state: cardRouteFixture(),
  choices: CHOICES,
  open: false,
  onOpen: () => {},
  onPick: () => {},
  ...over
})

describe('the third dial', () => {
  it('sits beside MDL and EFF as RTE, in the same chip', () => {
    const html = paint(dial())
    expect(html).toContain('>MDL<')
    expect(html).toContain('>EFF<')
    expect(html).toContain('>RTE<')
    expect(html).toContain('data-knob="route"')
    expect((html.match(/cr-tune-chip/g) ?? []).length).toBe(3)
  })

  it('is absent when the card may not have one', () => {
    const html = paint(null)
    expect(html).not.toContain('>RTE<')
    expect((html.match(/cr-tune-chip/g) ?? []).length).toBe(2)
  })

  it('reads direct', () => {
    const html = paint(dial({ state: cardRouteFixture({ route: 'direct', effective: null, live: null, turn: null }) }))
    expect(html).toContain('aria-label="Route: direct"')
    expect(html).toContain('>direct<')
  })

  it('reads the route it asked for and, under it, what this turn ran on and cost', () => {
    const html = paint(dial())
    expect(html).toContain('aria-label="Route: group/smart"')
    expect(html).toContain('>smart<') // the chip clips to the tail; the full id is in the name
    expect(html).toContain('→ deepseek/deepseek-v4 · 11.3k in · 1.1k out · $0.018')
  })

  it('says a pick applies on restart, wearing the pending colour', () => {
    const html = paint(dial({ state: cardRouteFixture({ route: 'deepseek/deepseek-v4', appliesOn: 'restart', turn: null, live: null }) }))
    expect(html).toContain('applies on restart')
    expect(html).toContain('cr-tune-chip pending')
  })

  it('says the requests will fail when the gateway goes down under a running routed card', () => {
    // Routed at spawn (effective is a model), gateway offline NOW: the same slot as the at-spawn line, the opposite sentence.
    const html = paint(dial({ state: cardRouteFixture({ gateway: 'offline' }) }))
    expect(html).toContain(GATEWAY_DOWN_NOW)
    expect(html).toContain('refused')
    expect(html).not.toContain('gateway offline · direct')
    // The chip keeps the route it was asked for and the last turn; nothing is rewritten to direct.
    expect(routeDialLines(cardRouteFixture({ gateway: 'offline' }))).toMatchObject({ value: 'group/smart', flag: 'offline', note: GATEWAY_DOWN_NOW })
    expect(routeDialLines(cardRouteFixture({ gateway: 'offline', note: 'codex needs a thinking-capable model behind the gateway' })).note).toBe(`${GATEWAY_DOWN_NOW} · codex needs a thinking-capable model behind the gateway`)
    // A direct process does not care that the gateway is down; neither does one not spawned yet.
    expect(routeDialLines(cardRouteFixture({ gateway: 'offline', effective: 'direct', route: 'direct' })).note).toBeNull()
    expect(routeDialLines(cardRouteFixture({ gateway: 'offline', effective: null, appliesOn: 'restart' }))).toMatchObject({ note: 'applies on restart', flag: 'restart' })
    // Offline AT SPAWN keeps its meaning and wins the slot: the process went direct and is fine.
    expect(routeDialLines(cardRouteFixture({ offline: true, gateway: 'offline' }))).toMatchObject({ value: 'direct', note: 'gateway offline · direct', flag: 'offline' })
    expect(routeDialLines(cardRouteFixture({ gateway: 'online' })).flag).toBeNull()
  })

  it('says direct and why when the gateway is offline', () => {
    const html = paint(dial({ state: cardRouteFixture({ offline: true }) }))
    expect(html).toContain('aria-label="Route: direct"')
    expect(html).toContain('gateway offline · direct')
    expect(html).toContain('cr-tune-chip refused')
  })

  it('opens a list with direct first, then the groups, then the models — the current one marked', () => {
    const html = paint(dial({ open: true }))
    const rows = [...html.matchAll(/role="option"[^>]*>([^<]+)</g)].map((m) => m[1])
    expect(rows.slice(0, 3)).toEqual(['direct', 'group/smart', 'group/opus-anywhere'])
    expect(rows.length).toBe(CHOICES.length)
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('cr-tune-row current group')
  })

  it('is ONE dial when main lists route among the knobs — never a generic chip reading the session file', () => {
    // Core pushes 'route' into AgentTuningState.knobs; the generic rail
    // skips it and RouteDial, fed by CardRouteState, is the only RTE.
    const html = paint(dial(), ['model', 'effort', 'route'])
    expect((html.match(/>RTE</g) ?? []).length).toBe(1)
    expect((html.match(/cr-tune-chip/g) ?? []).length).toBe(3)
    expect(html).toContain('data-knob="route"')
  })

  it('says pi is not routable yet, and offers no list', () => {
    const html = paint(dial({ notRoutable: 'direct · pi is not routable yet', open: true, state: null }))
    expect(html).toContain('direct · pi is not routable yet')
    expect(html).toContain('aria-label="Route: direct"')
    expect(html).not.toContain('role="option"')
  })

  it('shows the codex note under the value and keeps every model in the list', () => {
    const html = paint(dial({ state: cardRouteFixture({ note: 'codex needs a thinking-capable model behind the gateway' }), open: true }))
    expect(html).toContain('codex needs a thinking-capable model behind the gateway')
    const rows = [...html.matchAll(/role="option"[^>]*>([^<]+)</g)].map((m) => m[1])
    expect(rows.length).toBe(CHOICES.length)
  })

  it('prints a local turn as local, with tokens in and out, never $0.00', () => {
    const html = paint(dial({ state: localTurnFixture() }))
    expect(html).toContain('→ ollama/qwen3:32b · 1.8k in · 312 out · local')
    expect(html).not.toContain('$0')
  })

  it('shows a dash before the first read instead of guessing', () => {
    const html = paint(dial({ state: null }))
    expect(html).toContain('aria-label="Route: not read yet"')
  })
})
