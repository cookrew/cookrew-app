// LANE E2E-PANEL (design §5 and §9, renderer side): the Add menu's auto-group
// item is feature-detected off the setup lines, the dial reads `auto` for the
// local tier and its this-turn line is routePath, and the model reaches the
// echo and the commit toast. Static markup, the house way (no DOM env).

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AddMenu } from '../src/renderer/src/routing/RoutingSections'
import { TuneRail, type RouteDialProps } from '../src/renderer/src/nodes/TuneRail'
import { tuneRailView, type AgentTuningState } from '../src/shared/agent-tuning'
import { AUTO_GROUP, ROUTING_COPY, autoGroupExists, autoGroupItem, dialValue, routeChoices, routeDialLines, routePath } from '../src/shared/route-view'
import { setupLineAllowed } from '../src/shared/route-lines'
import { cardRouteFixture, routeFixture } from '../src/shared/route-fixture'
import type { Decision } from '../src/main/sous-control'

const AUTO_LINE = 'magpie group add auto models=ollama/qwen3:32b,ollama/qwen2.5:1.5b routing=smart stays=turn'

describe('1 · the Add menu offers the local tier only when main sent the script’s command', () => {
  const paint = (addAutoGroupLine?: string | null): string =>
    renderToStaticMarkup(<AddMenu setup={{ ...routeFixture('online').setup, ...(addAutoGroupLine === undefined ? {} : { addAutoGroupLine }) }} onRun={() => {}} defaultOpen />)

  it('is disabled with the reason on a main without the field, and when main sent null', () => {
    for (const html of [paint(undefined), paint(null)]) {
      const item = html.slice(html.indexOf('data-item="auto-group"') - 60, html.indexOf('data-item="auto-group"') + 400)
      expect(item).toContain('disabled=""')
      expect(item).toContain(ROUTING_COPY.addAutoGroup)
      expect(item).toContain(ROUTING_COPY.autoGroupNeedsScript)
    }
    expect(autoGroupItem({})).toEqual({ line: null, why: 'run the auto-group script once' })
  })

  it('is enabled with the printed command when main sent it — and only that exact shape passes the allowlist', () => {
    const html = paint(AUTO_LINE)
    const item = html.slice(html.indexOf('data-item="auto-group"') - 60, html.indexOf('data-item="auto-group"') + 400)
    expect(item).not.toContain('disabled=""')
    expect(item).toContain(AUTO_LINE)
    expect(autoGroupItem({ addAutoGroupLine: AUTO_LINE })).toEqual({ line: AUTO_LINE, why: null })
    expect(setupLineAllowed(AUTO_LINE)).toBe(true)
    for (const bad of ['magpie group add auto models=ollama/qwen3 routing=smart', 'magpie group add auto models=a,$(id) routing=smart stays=turn', 'node scripts/route-auto-group.mjs', 'magpie group add auto models=ollama/qwen3 routing=smart stays=turn; id']) {
      expect(setupLineAllowed(bad), bad).toBe(false)
    }
  })

  it('knows whether group/auto exists: main’s word first, else the catalog', () => {
    const online = routeFixture('online')
    expect(autoGroupExists(online)).toBe(false)
    expect(autoGroupExists({ ...online, models: [{ id: AUTO_GROUP, displayName: 'auto', ownedBy: 'magpie', group: true, reasoning: false, levels: [], contextWindow: null }, ...online.models] })).toBe(true)
    expect(autoGroupExists({ ...online, autoGroup: true })).toBe(true)
    expect(autoGroupExists({ models: [{ id: AUTO_GROUP, displayName: 'auto', ownedBy: 'magpie', group: true, reasoning: false, levels: [], contextWindow: null }], autoGroup: false })).toBe(false)
  })
})

describe('2 · the dial for a card on the local tier', () => {
  const T0 = 1_759_000_000_000
  function paint(route: RouteDialProps): string {
    const state: AgentTuningState = { harness: 'claude', knobs: ['model', 'effort'], records: ['model', 'effort'], tuning: { model: 'claude-opus-5', effort: 'high', at: T0 }, asks: [], caveat: null }
    const view = tuneRailView({ state, phase: 'idle', remote: false })
    if (view === null) throw new Error('this fixture must draw a rail')
    return renderToStaticMarkup(<TuneRail view={view} open={null} onOpen={() => {}} onTurn={() => {}} error={null} route={route} />)
  }
  const live = { terminalId: 'forge', session: 'cookrew:forge', seq: 12, asked: AUTO_GROUP, group: AUTO_GROUP, model: 'ollama/qwen3:32b', effort: null, tries: 1, done: true, status: null, at: T0, ttftMs: 900, ms: 4000, rule: { id: 'local-first', pick: 'ollama/qwen3:32b' } }

  it('reads auto, and the this-turn line is routePath: auto → <rule> → <model>', () => {
    const card = cardRouteFixture({ route: AUTO_GROUP, effective: AUTO_GROUP, live, turn: { model: 'ollama/qwen3:32b', inputTokens: 1800, outputTokens: 312, cost: null, priced: false, at: T0 } })
    const lines = routeDialLines(card)
    expect(lines.value).toBe('auto')
    expect(lines.turn).toBe(`this turn → ${routePath(live)} · 1.8k in · 312 out · local`)
    expect(routePath(live)).toBe('auto → local-first → ollama/qwen3:32b')
    const html = paint({ state: card, choices: routeChoices(routeFixture('online').models), open: false, onOpen: () => {}, onPick: () => {} })
    expect(html).toContain('<span class="cr-tune-v">auto</span>')
    expect(html).toContain('aria-label="Route: auto"')
    expect(html).toContain('→ auto → local-first → ollama/qwen3:32b · 1.8k in · 312 out · local')
    expect(dialValue(AUTO_GROUP)).toBe('auto')
    expect(dialValue('group/smart')).toBe('group/smart')
  })

  it('off the local tier and with no rule the line is the model alone, as before; on the tier without a rule it is the path; the turn’s own model wins', () => {
    const smart = { ...live, asked: 'group/smart', group: 'group/smart', rule: null, model: 'deepseek/deepseek-v4' }
    expect(routeDialLines(cardRouteFixture({ route: 'group/smart', live: smart, turn: null })).turn).toBe('this turn → deepseek/deepseek-v4')
    expect(routeDialLines(cardRouteFixture({ route: 'group/smart', live: smart, turn: { model: 'deepseek/deepseek-v4-flash', inputTokens: null, outputTokens: null, cost: 0.002, priced: true, at: T0 } })).turn).toBe('this turn → deepseek/deepseek-v4-flash · $0.0020')
    const tier = { ...live, rule: null }
    expect(routeDialLines(cardRouteFixture({ route: AUTO_GROUP, live: tier, turn: null })).turn).toBe('this turn → group/auto → ollama/qwen3:32b')
    expect(routeDialLines(cardRouteFixture({ route: AUTO_GROUP, live: tier, turn: { model: 'ollama/qwen2.5:1.5b', inputTokens: null, outputTokens: null, cost: null, priced: false, at: T0 } })).turn).toBe('this turn → group/auto → ollama/qwen2.5:1.5b · local')
  })
})

describe('3 · the model reaches the echo and the commit toast', () => {
  const stubDesktop = (): void => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
    ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
      location: { origin: 'http://localhost', search: '', hash: '', href: 'http://localhost/' },
      localStorage: storage,
      sessionStorage: storage,
      history: { replaceState: () => undefined },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      cookrew: {}
    }
    ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
  }
  const decision: Decision = {
    kind: 'ask',
    target: { id: 'forge', name: 'Forge' },
    alternates: [],
    reasons: ['idle', 'same repo', 'last touched README · 2h'],
    recruit: { harness: 'Claude Code', name: 'Install Section', beside: null, direct: false },
    token: 't1',
    holdMs: 2500,
    sentence: 'Make the install section of README English',
    route: { route: AUTO_GROUP, effective: 'ollama/qwen3:32b' }
  }

  it('the echo names the effective model; the toast after commit appends it to what Sous said', async () => {
    stubDesktop()
    vi.resetModules()
    const { CommandBox, echoLine, commitToast } = await import('../src/renderer/src/CommandBox')
    expect(echoLine(decision)).toBe('→ Forge · ollama/qwen3:32b (idle · same repo · last touched README · 2h)')
    const html = renderToStaticMarkup(<CommandBox open onClose={() => undefined} phone={false} rows={[]} initialDecision={decision} />)
    expect(html).toContain('→ Forge · ollama/qwen3:32b (idle · same repo · last touched README · 2h)')
    expect(commitToast('Sent to Forge', decision)).toBe('Sent to Forge · ollama/qwen3:32b')
    expect(commitToast('Sent to Forge', { ...decision, route: { route: AUTO_GROUP, effective: null } })).toBe('Sent to Forge')
    expect(commitToast('Sent to Forge', { ...decision, route: null })).toBe('Sent to Forge')
    expect(commitToast('', decision)).toBe('')
    const toast = renderToStaticMarkup(<CommandBox open onClose={() => undefined} phone={false} rows={[]} initialSaid={commitToast('Sent to Forge', decision)} />)
    expect(toast).toContain('<span class="line">Sent to Forge · ollama/qwen3:32b</span>')
  })
})
