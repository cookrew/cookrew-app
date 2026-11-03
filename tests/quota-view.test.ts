// EACH ACCOUNT, AS THE PANEL SAYS IT (route program, Magpie settings).
//
// Pure: what is left of every window, when it comes back, and roughly how
// many tokens that is — computed from what the window already spent
// (tokens ÷ percent used = the whole; the whole × percent left = what is
// left), and only when the gateway gave the spend: a window magpie itself
// will not estimate ("low", "new", "stale") says why instead of a number.

import { describe, expect, it } from 'vitest'
import { compactCount, inDuration, mcpLibraryLine, percentUsed, quotaFacts, windowView } from '../src/shared/quota-view'
import type { RouteQuota, RouteQuotaWindow } from '../src/shared/route'

const NOW = Date.parse('2026-11-03T20:00:00+08:00')
const H = 3_600_000

function win(over: Partial<RouteQuotaWindow>): RouteQuotaWindow {
  return { name: '7 days', used: null, limit: null, resetsAt: null, display: null, ...over }
}

function quota(over: Partial<RouteQuota>): RouteQuota {
  return { provider: 'codex', account: null, alias: null, plan: null, kind: 'subscription', windows: [], last: false, error: null, ...over }
}

describe('numbers', () => {
  it('compacts counts', () => {
    expect(compactCount(24_147_633)).toBe('24M')
    expect(compactCount(5_630_000)).toBe('5.6M')
    expect(compactCount(1_250_000_000)).toBe('1.3B')
    expect(compactCount(12_400)).toBe('12k')
    expect(compactCount(980)).toBe('980')
  })

  it('says a duration in its two largest parts', () => {
    expect(inDuration(5 * 24 * H + 3 * H + 120_000)).toBe('5d 3h')
    expect(inDuration(4 * H + 12 * 60_000)).toBe('4h 12m')
    expect(inDuration(12 * 60_000)).toBe('12m')
    expect(inDuration(20_000)).toBe('<1m')
  })
})

describe('percentUsed', () => {
  it('is used/limit with a limit, the percent itself when used + left make 100, else unknown', () => {
    expect(percentUsed(win({ used: 25, limit: 50 }))).toBe(50)
    expect(percentUsed(win({ used: 30, remaining: 70 }))).toBe(30)
    expect(percentUsed(win({ used: 28.999999999999996, remaining: 71 }))).toBeCloseTo(29)
    expect(percentUsed(win({ used: 5 }))).toBeNull()
  })
})

describe('windowView', () => {
  it('a percent window: what is left, when it resets, and the tokens that is', () => {
    const v = windowView(win({ used: 30, remaining: 70, resetsAt: NOW + 5 * 24 * H, tokensUsed: 24_147_633, valueUsed: 2607.5 }), NOW)
    expect(v.leftFill).toBeCloseTo(0.7)
    expect(v.left).toBe('70% left')
    expect(v.resets).toBe('resets in 5d')
    expect(v.tokens).toBe('≈56M tokens left · 24M used')
    expect(v.value).toBe('$2,608 at API prices')
    expect(v.hot).toBe(false)
  })

  it('a window magpie will not estimate says why, never a guessed number', () => {
    const v = windowView(win({ used: 0, remaining: 100, estimateWhy: 'low' }), NOW)
    expect(v.left).toBe('100% left')
    expect(v.tokens).toBeNull()
    expect(v.note).toBe('too little use yet to estimate tokens')
    expect(windowView(win({ used: 10, remaining: 90, estimateWhy: 'stale' }), NOW).note).toBe('usage too old to estimate tokens')
  })

  it('a credits window counts in its unit; a spent window is hot; a past reset is resetting', () => {
    const credits = windowView(win({ name: 'Credits', used: 20, limit: 100, remaining: 80, unit: 'credits' }), NOW)
    expect(credits.left).toBe('80 credits left')
    expect(credits.leftFill).toBeCloseTo(0.8)
    const spent = windowView(win({ used: 95, remaining: 5, resetsAt: NOW - 1000 }), NOW)
    expect(spent.hot).toBe(true)
    expect(spent.resets).toBe('resetting')
  })

  it('a bare counter has no bar and shows the gateway\'s own rendering when there is one', () => {
    const v = windowView(win({ used: 7, display: '7 calls' }), NOW)
    expect(v.leftFill).toBeNull()
    expect(v.left).toBe('7 calls')
  })
})

describe('quotaFacts', () => {
  it('reset credits, the plan end, and how old the reading is', () => {
    const facts = quotaFacts(quota({ resetCredits: { count: 3, firstExpiresAt: NOW + 3 * 24 * H + 2 * H }, until: Date.parse('2027-03-28T16:39:59Z'), readAt: NOW - 4 * 60_000 }), NOW)
    expect(facts).toEqual(['3 resets in hand · first expires in 3d 2h', 'plan until 2027-03-28', 'read 4m ago'])
  })

  it('one reset is singular; nothing known is nothing said', () => {
    expect(quotaFacts(quota({ resetCredits: { count: 1, firstExpiresAt: null } }), NOW)).toEqual(['1 reset in hand'])
    expect(quotaFacts(quota({}), NOW)).toEqual([])
  })
})

describe('mcpLibraryLine', () => {
  it('names what the hub shares, or says how to add some', () => {
    expect(mcpLibraryLine(['context7', 'memory'])).toBe('hub shares context7, memory')
    expect(mcpLibraryLine([])).toBe("hub shares nothing yet · add servers in Magpie › Library")
    expect(mcpLibraryLine(null)).toBe("Magpie's library could not be read")
    expect(mcpLibraryLine(undefined)).toBe("Magpie's library could not be read")
  })
})
