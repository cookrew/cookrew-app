// PERMANENT gate-order conformance gate (v4 §4): ONE gate, ONE order,
// deny-by-default — 401 → 403 → 429 → 402. The order is the security
// property: authenticate before existence leaks (401 before any 404/403
// resolution), authorize before throttling, throttle before settlement (no
// body-heavy work under overload), settle before execute. The matrix test
// below enumerates EVERY combination of failing conditions so a reorder
// cannot slip through a sampled test.

import { describe, expect, it } from 'vitest'
import { gateDecision, type GateConsumer } from '../src/shared/gate'

const phone: GateConsumer = { groups: ['observe', 'dispatch', 'orchestrate', 'terminal-io', 'admin'], workspaces: '*' }
const wall: GateConsumer = { groups: ['observe'], workspaces: '*' }
const haSous: GateConsumer = { groups: ['observe', 'dispatch'], workspaces: ['homelab-*'] }
const customer: GateConsumer = { groups: ['observe', 'dispatch'], workspaces: ['inst-42'], agents: ['entry'] }

describe('gateDecision — Sol F9 named cases', () => {
  it('/auth/status is public: no token at all still gets 200', () => {
    expect(gateDecision({ consumer: null, route: 'public' })).toEqual({ status: 200, reason: 'public' })
  })

  it('wall-token write is 403, not 401 (the token is KNOWN; the route is outside its groups)', () => {
    const decision = gateDecision({ consumer: wall, route: 'orchestrate' })
    expect(decision.status).toBe(403)
    expect(decision).toEqual({ status: 403, reason: 'route-not-in-groups' })
  })

  it('wall-token terminal-io is likewise 403 (raw bytes were never the wall\'s scope)', () => {
    expect(gateDecision({ consumer: wall, route: 'terminal-io' }).status).toBe(403)
  })

  it('an unknown token gets 401 even on a route it would never reach (authenticate before existence)', () => {
    expect(gateDecision({ consumer: null, route: 'observe' })).toEqual({ status: 401, reason: 'unknown-token' })
    expect(gateDecision({ consumer: null, route: null })).toEqual({ status: 401, reason: 'unknown-token' })
  })

  it('a known token on an unclassified route is deny-by-default 403', () => {
    expect(gateDecision({ consumer: phone, route: null })).toEqual({ status: 403, reason: 'unclassified-route' })
  })
})

describe('gateDecision — scope authorization', () => {
  it('workspace glob scope: homelab-* admits homelab-nas, denies cookrew', () => {
    expect(
      gateDecision({ consumer: haSous, route: 'dispatch', target: { workspace: 'homelab-nas' } }).status
    ).toBe(200)
    expect(gateDecision({ consumer: haSous, route: 'dispatch', target: { workspace: 'cookrew' } })).toEqual({
      status: 403,
      reason: 'workspace-out-of-scope'
    })
  })

  it('exact workspace scope admits only the instance workspace', () => {
    expect(
      gateDecision({ consumer: customer, route: 'observe', target: { workspace: 'inst-42' } }).status
    ).toBe(200)
    expect(
      gateDecision({ consumer: customer, route: 'observe', target: { workspace: 'inst-43' } }).status
    ).toBe(403)
  })

  it("agent scope: the customer reaches 'entry' and no teammate", () => {
    expect(
      gateDecision({ consumer: customer, route: 'dispatch', target: { workspace: 'inst-42', agent: 'entry' } })
        .status
    ).toBe(200)
    expect(
      gateDecision({ consumer: customer, route: 'dispatch', target: { workspace: 'inst-42', agent: 'teammate' } })
    ).toEqual({ status: 403, reason: 'agent-out-of-scope' })
  })

  it("'*' scope imposes no constraint; absent agent scope is unconstrained", () => {
    expect(
      gateDecision({ consumer: haSous, route: 'dispatch', target: { workspace: 'homelab-x', agent: 'anyone' } })
        .status
    ).toBe(200)
    expect(gateDecision({ consumer: phone, route: 'admin', target: { workspace: 'anything' } }).status).toBe(200)
  })

  it('an absent target cannot fail OBSERVE scope (serializer-side scoping is wave B, Sol F7)', () => {
    expect(gateDecision({ consumer: customer, route: 'observe' }).status).toBe(200)
  })

  it('D2a: a scoped consumer on a BODY-ADDRESSED route fails closed — workspace-unresolvable', () => {
    // Body-addressed routes name no workspace in the path, so target.workspace
    // is undefined; without this, scope passed vacuously and a workspace-
    // scoped consumer was unconstrained — cross-tenant dispatch the day a
    // real token exists. scopedPhone HAS every group, so only the fail-closed
    // step can fire.
    const scopedPhone: GateConsumer = {
      groups: ['observe', 'dispatch', 'orchestrate', 'terminal-io', 'admin'],
      workspaces: ['inst-*']
    }
    for (const route of ['dispatch', 'orchestrate', 'terminal-io', 'admin'] as const) {
      expect(gateDecision({ consumer: scopedPhone, route })).toEqual({
        status: 403,
        reason: 'workspace-unresolvable'
      })
    }
  })

  it("D2a: '*' consumers stay unconstrained and observe stays exempt on absent targets", () => {
    expect(gateDecision({ consumer: phone, route: 'dispatch' }).status).toBe(200)
    expect(gateDecision({ consumer: haSous, route: 'observe' }).status).toBe(200)
  })
})

describe('gateDecision — throttle and settle', () => {
  it('throttled → 429', () => {
    expect(gateDecision({ consumer: phone, route: 'observe', state: { throttled: true } })).toEqual({
      status: 429,
      reason: 'throttled'
    })
  })

  it('payable + unfunded → 402; payable + funded → 200', () => {
    // In-scope target supplied: post-D2a a scoped consumer on dispatch with
    // no resolvable workspace never REACHES the settle step.
    const target = { workspace: 'inst-42' }
    expect(
      gateDecision({ consumer: customer, route: 'dispatch', target, state: { payable: true, funded: false } })
    ).toEqual({ status: 402, reason: 'payment-required' })
    expect(
      gateDecision({ consumer: customer, route: 'dispatch', target, state: { payable: true, funded: true } })
        .status
    ).toBe(200)
  })

  it('unpayable routes never 402 even when unfunded', () => {
    expect(gateDecision({ consumer: customer, route: 'observe', state: { funded: false } }).status).toBe(200)
  })
})

describe('gateDecision — the full order matrix (every failing combination)', () => {
  // One flag per failing gate step, in gate order. Expected outcome = the
  // EARLIEST failing step; 200 only when none fail. 2^5 = 32 combinations.
  interface Flags {
    noToken?: boolean
    outOfGroup?: boolean
    outOfScope?: boolean
    throttled?: boolean
    unfundedPayable?: boolean
  }
  const ORDER = ['noToken', 'outOfGroup', 'outOfScope', 'throttled', 'unfundedPayable'] as const
  const STATUS: Record<(typeof ORDER)[number], number> = {
    noToken: 401,
    outOfGroup: 403,
    outOfScope: 403,
    throttled: 429,
    unfundedPayable: 402
  }

  const combinations: Flags[] = [{}]
  for (const step of ORDER) {
    for (const existing of [...combinations]) combinations.push({ ...existing, [step]: true })
  }
  expect(combinations.length).toBe(32)

  for (const flags of combinations) {
    const earliest = ORDER.find((step) => flags[step])
    const label = earliest ? `fails at ${earliest} → ${STATUS[earliest]}` : 'nothing fails → 200'
    it(label, () => {
      const decision = gateDecision({
        consumer: flags.noToken ? null : { groups: flags.outOfGroup ? ['observe'] : ['observe', 'dispatch'], workspaces: ['ws-1'] },
        route: 'dispatch',
        target: { workspace: flags.outOfScope ? 'elsewhere' : 'ws-1' },
        state: { throttled: flags.throttled, payable: true, funded: !flags.unfundedPayable }
      })
      expect(decision.status).toBe(earliest ? STATUS[earliest] : 200)
    })
  }
})
