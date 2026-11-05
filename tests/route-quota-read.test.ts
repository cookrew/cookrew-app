// WHAT THE GATEWAY SAYS ABOUT EACH ACCOUNT (route program, Magpie settings).
//
// The rows below are the shape magpie 0.1.2597 answered on 2026-11-03, with
// the identities taken out. A window's `used` is a PERCENT with no `limit`;
// `holds` is what the account spent in the window (tokens, API-price value);
// `holdsWhy` says why a window has no such figure; a prepaid provider is
// `kind: "balance"` with a `balance` sentence; Codex carries reset credits
// and the date its plan ends. The library read gives names, never env.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toQuota, toQuotas } from '../src/main/route/catalog'
import { readLibraryServers } from '../src/main/route/library'

const CLAUDE = {
  provider: 'claude', name: 'Claude Code', kind: 'subscription', plan: 'max', user: 'o@x',
  windows: [
    { name: '7 days', used: 30, remaining: 70, resetsAt: '2026-11-08T20:00:00+08:00', holds: { tokens: 24147633, cost: 2607.525, priced: true, used: 30, since: '2026-11-01T20:00:00+08:00' } },
    { name: '7 days · Fable', used: 0, remaining: 100, resetsAt: '2026-11-08T20:00:00+08:00', holdsWhy: 'low' }
  ],
  readAt: '2026-11-03T20:44:53+08:00', last: true
}
const CODEX = {
  provider: 'codex', name: 'Codex', kind: 'subscription', plan: 'team', user: 'o@x',
  windows: [{ name: '7 days', used: 56, remaining: 44, resetsAt: '2026-11-04T15:56:51+08:00', holds: { tokens: 13089171, cost: 92.99, priced: false, used: 56 } }],
  until: '2027-03-28T16:39:59Z',
  resets: { count: 3, until: '2026-11-06T23:30:38Z', each: [{ until: '2026-11-06T23:30:38Z', id: 'a' }] }
}
const WORKBUDDY = { provider: 'workbuddy-ai', kind: 'subscription', plan: 'Free plan', windows: [{ name: 'Credits', used: 0, remaining: 100, limit: 100, unit: 'credits', display: '0 / 100', holdsWhy: 'low' }] }
const DEEPSEEK = { provider: 'deepseek', name: 'DeepSeek', kind: 'balance', windows: [], balance: '$64.90 · ¥-0.00', user: null }

describe('a quota row, read', () => {
  it('keeps what is left, the reset, and what the window spent', () => {
    const q = toQuota(CLAUDE)!
    expect(q.kind).toBe('subscription')
    expect(q.readAt).toBe(Date.parse('2026-11-03T20:44:53+08:00'))
    expect(q.windows[0]).toEqual({
      name: '7 days', used: 30, limit: null, remaining: 70, unit: null, display: null,
      resetsAt: Date.parse('2026-11-08T20:00:00+08:00'),
      tokensUsed: 24147633, valueUsed: 2607.525, since: Date.parse('2026-11-01T20:00:00+08:00'), estimateWhy: null
    })
    expect(q.windows[1]).toMatchObject({ tokensUsed: null, valueUsed: null, estimateWhy: 'low' })
  })

  it('an unpriced spend has no value; reset credits and the plan end are kept', () => {
    const q = toQuota(CODEX)!
    expect(q.windows[0]).toMatchObject({ tokensUsed: 13089171, valueUsed: null })
    expect(q.until).toBe(Date.parse('2027-03-28T16:39:59Z'))
    expect(q.resetCredits).toEqual({ count: 3, firstExpiresAt: Date.parse('2026-11-06T23:30:38Z') })
  })

  it('a credits window keeps its unit and limit', () => {
    expect(toQuota(WORKBUDDY)!.windows[0]).toMatchObject({ used: 0, limit: 100, remaining: 100, unit: 'credits', display: '0 / 100' })
  })

  it('a prepaid provider is a balance, in the gateway\'s own words', () => {
    const q = toQuota(DEEPSEEK)!
    expect(q.kind).toBe('balance')
    expect(q.balance).toBe('$64.90 · ¥-0.00')
    expect(q.resetCredits).toBeNull()
    expect(q.until).toBeNull()
  })

  it('reads the real envelope', () => {
    expect(toQuotas({ data: [CLAUDE, CODEX, WORKBUDDY, DEEPSEEK] }).map((q) => [q.provider, q.kind])).toEqual([
      ['claude', 'subscription'], ['codex', 'subscription'], ['workbuddy-ai', 'subscription'], ['deepseek', 'balance']
    ])
  })
})

describe('the library the hub shares', () => {
  let home = ''
  afterEach(() => home && rmSync(home, { recursive: true, force: true }))
  const at = (body: string | null, xdg = false): { home: string; env: Record<string, string> } => {
    home = mkdtempSync(path.join(tmpdir(), 'mag-lib-'))
    const dir = xdg ? path.join(home, 'xdg', 'magpie') : path.join(home, '.config', 'magpie')
    mkdirSync(dir, { recursive: true })
    if (body !== null) writeFileSync(path.join(dir, 'library.json'), body)
    return { home, env: xdg ? { XDG_CONFIG_HOME: path.join(home, 'xdg') } : {} }
  }

  it('names the servers and nothing else (an env value never leaves the file)', () => {
    const d = at(JSON.stringify({ mcp: [{ name: 'context7', url: 'https://x' }, { name: 'github', env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secret' } }] }))
    const names = readLibraryServers(d)
    expect(names).toEqual(['context7', 'github'])
    expect(JSON.stringify(names)).not.toContain('ghp_')
  })

  it('an empty library is an empty list; a missing or broken file is unknown', () => {
    expect(readLibraryServers(at(JSON.stringify({ mcp: null })))).toEqual([])
    rmSync(home, { recursive: true, force: true })
    expect(readLibraryServers(at(null))).toBeNull()
    rmSync(home, { recursive: true, force: true })
    expect(readLibraryServers(at('{not json'))).toBeNull()
  })

  it('follows XDG_CONFIG_HOME like magpie does', () => {
    expect(readLibraryServers(at(JSON.stringify({ mcp: [{ name: 'memory' }] }), true))).toEqual(['memory'])
  })
})
