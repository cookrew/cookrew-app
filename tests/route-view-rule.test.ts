// THE RULE ON THE RAIL AND IN R1 (HP round): a turn that a group rule
// routed prints `auto → <rule> → <model>`; one a group picked without a rule
// prints `<group> → <model>`; a plain model prints itself. Velvet's lines
// without a rule are unchanged.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { toDecision } from '../src/main/route/decisions'
import { cardRouteFixture } from '../src/shared/route-fixture'
import { decisionFacts, routeDialLines, routeHead, routePath } from '../src/shared/route-view'
import type { RouteDecision } from '../src/shared/route'

const base: RouteDecision = { terminalId: 'c', session: 'cookrew:c', seq: 1, asked: 'group/smart', group: 'group/smart', model: 'ollama/qwen3:4b', effort: 'low', tries: 1, done: false, status: null, at: 1, ttftMs: null, ms: null, rule: null }

describe('the route path', () => {
  it('auto → rule → model under a rule; group → model without; the model alone for a plain ask', () => {
    expect(routePath({ ...base, rule: { id: 'night-cheap', pick: 'low' } })).toBe('auto → night-cheap → ollama/qwen3:4b')
    expect(routePath(base)).toBe('group/smart → ollama/qwen3:4b')
    expect(routePath({ ...base, group: null, asked: 'ollama/qwen3:4b' })).toBe('ollama/qwen3:4b')
    expect(routePath({ ...base, rule: { id: 'r', pick: null }, model: null })).toBe('auto → r → —')
  })

  it("R1's first column says auto → rule, else the group, the ask, or direct", () => {
    expect(routeHead({ ...base, rule: { id: 'night-cheap', pick: 'low' } })).toBe('auto → night-cheap')
    expect(routeHead(base)).toBe('group/smart')
    expect(routeHead({ ...base, group: null, asked: null })).toBe('direct')
  })

  it('the facts are unchanged by a rule — the path already names what it picked', () => {
    const ruled: RouteDecision = { ...base, ttftMs: 2300, rule: { id: '1', pick: 'ollama/qwen3:1.7b' } }
    expect(decisionFacts(ruled)).toBe('first token 2.3 s')
    expect(decisionFacts({ ...base, ttftMs: 2300 })).toBe('first token 2.3 s')
  })

  it("the real bodies: the think turn prints auto → 1 → the model, the plain turn never prints 'auto → 0'", () => {
    const plain = toDecision('hp-plain', JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'magpie', 'route-hp-plain.json'), 'utf8')), 1)!
    const think = toDecision('hp-think', JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'magpie', 'route-hp-think.json'), 'utf8')), 1)!
    expect(routePath(think)).toBe('auto → 1 → ollama/qwen3:1.7b')
    expect(routeHead(think)).toBe('auto → 1')
    expect(routePath(plain)).toBe('think → ollama/qwen2.5:1.5b')
    expect(routeHead(plain)).toBe('think')
    expect(routePath(plain)).not.toContain('auto')
    expect(routeDialLines(cardRouteFixture({ turn: null, live: think })).turn).toBe('this turn → auto → 1 → ollama/qwen3:1.7b')
    expect(routeDialLines(cardRouteFixture({ turn: null, live: plain })).turn).toBe('this turn → ollama/qwen2.5:1.5b')
  })

  it("the rail's this-turn line carries the rule, and stays as it was without one", () => {
    const card = cardRouteFixture()
    const without = routeDialLines(card).turn
    expect(without).not.toContain('auto →')
    const ruled = cardRouteFixture({ live: { ...(card.live ?? base), rule: { id: 'night-cheap', pick: 'low' } } })
    expect(routeDialLines(ruled).turn).toMatch(/^this turn → auto → night-cheap → /)
    const liveOnly = cardRouteFixture({ turn: null, live: { ...base, rule: { id: 'r', pick: null } } })
    expect(routeDialLines(liveOnly).turn).toBe('this turn → auto → r → ollama/qwen3:4b')
  })
})
