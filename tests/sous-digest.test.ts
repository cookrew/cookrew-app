// THE DIGEST AND THE BUDGET (HP round): 200 cards in one positional table under
// 2,500 tokens, decide() on them under 50 ms, and NOT ONE pane capture on the
// way — the candidates come from the Board and the tracker's mirror.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { approxTokens, buildDigest, digestOrder, type DigestCard } from '../src/shared/sous-digest'
import { decide, type DecideCandidate } from '../src/shared/sous-decide'

const NOW = Date.parse('2026-10-12T09:00:00Z')
const PHASES = ['done', 'working', 'waiting', 'unread', 'offline'] as const
const ROLES = ['Developer', 'Bugfix', 'QA (Browser)', 'UI designer', null, 'Orchestrator']

/** 200 cards across 5 repos, long titles, a few served and a few full — the fleet on a bad day. */
function fleet(n = 200): DigestCard[] {
  const out: DigestCard[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      id: `card-${i}`,
      name: `Agent ${i} ${i % 7 === 0 ? 'with a very long name indeed' : ''}`.trim(),
      harness: ['Claude Code', 'Codex', 'Pi', 'OpenCode'][i % 4],
      role: ROLES[i % ROLES.length],
      orch: i % 40 === 0,
      phase: PHASES[i % PHASES.length],
      cwd: `/repo/${['cookrew', 'site', 'registry', 'herdr', 'docs'][i % 5]}`,
      lastTask: `turn ${i}: refactor the ${['inbox', 'board', 'relay', 'cable', 'route'][i % 5]} module and keep every test green while the owner watches the long tail`,
      lastActivityAt: NOW - i * 7 * 60_000,
      served: i % 23 === 0,
      contextFull: i % 17 === 0
    })
  }
  return out
}

describe('buildDigest — one positional table under the budget', () => {
  it('200 cards fit under 2,500 tokens, the table is numbered, and the footer says what was left out', () => {
    const d = buildDigest(fleet(), { workdir: '/repo/cookrew', now: NOW })
    expect(d.tokens).toBeLessThanOrEqual(2500)
    expect(d.text).toMatch(/^workdir: \/repo\/cookrew · cards: 200\n# \| card \| harness/)
    expect(d.text).toMatch(/\n1 \| Agent/)
    expect(d.listed.length + d.omitted).toBe(200)
    if (d.omitted > 0) expect(d.text).toMatch(new RegExp(`\\+${d.omitted} more cards not listed$`))
  })

  it('the cards a brief can go to come first: same-repo idle, then same-repo busy, then the rest, seats last', () => {
    const ordered = digestOrder(fleet(), '/repo/cookrew')
    const firstBand = ordered.filter((c) => c.cwd === '/repo/cookrew' && ['done', 'waiting', 'unread'].includes(c.phase) && !c.contextFull && !c.served)
    expect(ordered.slice(0, firstBand.length).every((c) => c.cwd === '/repo/cookrew')).toBe(true)
    expect(ordered.at(-1)?.served).toBe(true)
  })

  it('approxTokens counts CJK by character and Latin by chars/3.2, erring high', () => {
    expect(approxTokens('abcdefgh')).toBe(3)
    expect(approxTokens('把测试跑绿')).toBe(5)
    expect(approxTokens('')).toBe(0)
  })

  it('a tiny budget still yields a well-formed table with a footer', () => {
    const d = buildDigest(fleet(), { workdir: '/repo/cookrew', now: NOW, maxTokens: 120 })
    expect(d.tokens).toBeLessThanOrEqual(120)
    expect(d.omitted).toBeGreaterThan(150)
    expect(d.text).toMatch(/more cards not listed$/)
  })
})

describe('decide on the fleet — fast, and without a single pane capture', () => {
  const candidates: DecideCandidate[] = fleet().map((c) => ({ id: c.id, name: c.name, workspaceId: 'ws', cwd: c.cwd, role: c.role, orch: c.orch, phase: c.phase as DecideCandidate['phase'], contextFull: c.contextFull ?? false, lastTask: c.lastTask, lastActivityAt: c.lastActivityAt, served: c.served }))

  it('200 cards decide in under 50 ms', () => {
    const t0 = performance.now()
    for (let i = 0; i < 5; i++) decide('refactor the inbox module and keep every test green', { candidates, workdir: '/repo/cookrew', now: NOW })
    const perCall = (performance.now() - t0) / 5
    expect(perCall).toBeLessThan(50)
  })

  it('a served card is never the target, even when its words match', () => {
    const d = decide('refactor the inbox module and keep every test green', { candidates, workdir: '/repo/cookrew', now: NOW })
    if (d.kind === 'ask') {
      const target = candidates.find((c) => c.id === d.target.id)
      expect(target?.served).toBe(false)
      for (const a of d.alternates.filter((a) => a.kind === 'ask')) expect(candidates.find((c) => c.id === a.id)?.served).toBe(false)
    }
  })

  // Source proxy (house pattern): the candidate builder in index.ts reads
  // context-full from the tracker's mirror and never captures a pane.
  it('index.ts builds candidates with no pane capture — contextFullCached, not captureAsync', () => {
    const main = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
    const start = main.indexOf('candidates: async () => {')
    const block = main.slice(start, main.indexOf('recruit: ({ preset, name, brief, besideId', start))
    expect(block).toContain('turns.contextFullCached(t.id)')
    expect(block).not.toMatch(/captureAsync|\.capture\(|contextExhausted\(/)
    const tracker = readFileSync(join(__dirname, '../src/main/turn-tracker.ts'), 'utf8')
    expect(tracker).toContain('contextExhausted(t.session.viewportText())')
  })
})
