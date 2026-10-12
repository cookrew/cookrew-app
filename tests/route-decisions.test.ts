// THE LONG-POLL PER CARD IN FLIGHT (route program, core lane): one request at
// a time per card, none when idle, the decision rows and the turn facts
// mapped from the real answers, all against a fake gateway on a free port.

import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { RouteDecisions, pushLive, toDecision, toTurnFacts } from '../src/main/route/decisions'
import type { RouteDecision } from '../src/shared/route'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Fake {
  url: string
  calls: { path: string; at: number }[]
  open: number
  usageSessions: string[]
  /** Scripted answers per `after=` seq for the route poll. */
  answers: Map<number, unknown>
  close: () => Promise<void>
}

async function fakeGateway(): Promise<Fake> {
  const fake: Fake = { url: '', calls: [], open: 0, usageSessions: ['cookrew:card-1'], answers: new Map(), close: async () => {} }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    fake.calls.push({ path: req.url ?? '', at: Date.now() })
    if (url.pathname === '/v1/magpie/route') {
      fake.open += 1
      const after = Number(url.searchParams.get('after') ?? '0')
      // The real gateway holds the answer until the route changes; this one holds 40 ms.
      await sleep(40)
      fake.open -= 1
      const body = fake.answers.get(after) ?? { route: null, seq: after, session: url.searchParams.get('session') }
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify(body))
    }
    if (url.pathname === '/v1/magpie/usage/requests') {
      // Like the real gateway: a session it knows answers its row; one it does
      // not answers the latest row of all (another session's).
      const asked = url.searchParams.get('session') ?? ''
      const known = fake.usageSessions.includes(asked)
      // Newest first, as the gateway answers: a cancelled 499 on top (round 3), the turn behind it.
      return res.end(JSON.stringify({ rows: [
        { t: '2026-10-11T06:13:59.000Z', status: 499, in: 0, out: 0, session: known ? asked : 'somebody-else' },
        { t: '2026-10-11T06:13:57.702Z', status: 200, served: 'claude/claude-sonnet-5-5', model: 'group/smart', in: 32, out: 3027, cost: 0.4357, priced: true, session: known ? asked : 'somebody-else' }
      ], total: 2 }))
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  fake.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  fake.close = () => new Promise((r) => server.close(() => r()))
  return fake
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c()
})

describe('mapping', () => {
  it('a route answer becomes a decision row; no route yet is null', () => {
    expect(toDecision('card-1', { route: null, seq: 0, session: 'cookrew:card-1' }, 5)).toBeNull()
    const d = toDecision('card-1', { route: { asked: 'group/smart', group: 'group/smart', model: 'deepseek/deepseek-chat', effort: 'high', tries: [{ model: 'claude/x', fail: '429' }, { model: 'deepseek/deepseek-chat' }], done: false }, seq: 4, session: 'cookrew:card-1' }, 5)
    expect(d).toEqual({ terminalId: 'card-1', session: 'cookrew:card-1', seq: 4, asked: 'group/smart', group: 'group/smart', model: 'deepseek/deepseek-chat', effort: 'high', tries: 2, done: false, status: null, at: 5, ttftMs: null, ms: null , rule: null})
  })

  it('the real route answer: time stamped by the gateway, tries an array, group absent for a plain model, ttft and ms kept', () => {
    // Verbatim from magpie 0.1.1182 (round 2), trimmed.
    const real = { route: { id: 1791699193049, time: '2026-10-11T14:24:32.197169+08:00', asked: 'ollama/qwen2.5:1.5b', asked_effort: 'high', model: 'ollama/qwen2.5:1.5b', effort: 'high', served: 'qwen2.5:1.5b', tries: [{ model: 'ollama/qwen2.5:1.5b', effort: 'high', done: true, status: 200, ms: 4267 }], done: true, status: 200, ttft_ms: 812, ms: 4267 }, seq: 1, session: 'cookrew:probe-claude' }
    const d = toDecision('probe-claude', real, 1)
    expect(d).toMatchObject({ asked: 'ollama/qwen2.5:1.5b', group: null, model: 'ollama/qwen2.5:1.5b', effort: 'high', tries: 1, done: true, status: '200', ttftMs: 812, ms: 4267, seq: 1 })
    expect(d?.at).toBe(Date.parse('2026-10-11T14:24:32.197169+08:00'))
  })

  it("keeps the group's rule and its pick; a bare rule name is an id; absent is null (HP round)", () => {
    // SYNTHESISED from reference.md ("rule (the group's rule that matched,
    // and rule.pick, the effort its decision model picked)"): no group on
    // this Mac has a rule yet, so no real body could be recorded. Marked so
    // the first real one replaces it.
    const withRule = { route: { asked: 'group/smart', group: 'group/smart', rule: { id: 'night-cheap', pick: 'low' }, model: 'ollama/qwen3:4b', effort: 'low', tries: [{}], done: false }, seq: 2, session: 'cookrew:c' }
    expect(toDecision('c', withRule, 1)?.rule).toEqual({ id: 'night-cheap', pick: 'low' })
    expect(toDecision('c', { route: { asked: 'x', rule: 'by-hour', model: 'm', done: false }, seq: 1 }, 1)?.rule).toEqual({ id: 'by-hour', pick: null })
    expect(toDecision('c', { route: { asked: 'x', rule: { pick: 'high' }, model: 'm', done: false }, seq: 1 }, 1)?.rule).toBeNull()
    expect(toDecision('c', { route: { asked: 'x', model: 'm', done: false }, seq: 1 }, 1)?.rule).toBeNull()
  })

  it('the usage row becomes turn facts; an unpriced (local) row has no cost', () => {
    expect(toTurnFacts({ rows: [{ t: '2026-10-11T06:13:57.702Z', status: 200, served: 'claude/claude-sonnet-5-5', in: 32, out: 3027, cost: 0.4357, priced: true }] })).toEqual({
      model: 'claude/claude-sonnet-5-5', inputTokens: 32, outputTokens: 3027, cost: 0.4357, priced: true, at: Date.parse('2026-10-11T06:13:57.702Z')
    })
    // The real local row (round 2): cost 0, priced false — the rail says "local", never "$0.00".
    expect(toTurnFacts({ rows: [{ t: '2026-10-11T06:26:01.334Z', agent: 'cookrew', model: 'qwen2.5:1.5b', in: 3, out: 1, status: 200, session: 'cookrew:probe-codex', cost: 0, priced: false }] })).toMatchObject({ cost: null, priced: false, model: 'qwen2.5:1.5b' })
  })

  it("the newest row is not the turn: codex's cancelled 499 sits on top of the 200 that has the tokens (round 3)", () => {
    const rows = [
      { t: '2026-10-11T08:00:05.000Z', status: 499, in: 0, out: 0, served: 'ollama/qwen3', session: 'cookrew:c' },
      { t: '2026-10-11T08:00:01.000Z', status: 200, in: 120, out: 48, served: 'ollama/qwen3', session: 'cookrew:c', cost: 0, priced: false }
    ]
    expect(toTurnFacts({ rows }, ['cookrew:c'])).toMatchObject({ outputTokens: 48, inputTokens: 120, at: Date.parse('2026-10-11T08:00:01.000Z') })
    // A 200 with no output is not a turn either; a 499 alone is nothing.
    expect(toTurnFacts({ rows: [rows[0]] }, ['cookrew:c'])).toBeNull()
    expect(toTurnFacts({ rows: [{ status: 200, out: 0, session: 'cookrew:c' }] }, ['cookrew:c'])).toBeNull()
    // The status may arrive as a string; the newest 200 wins over an older one.
    expect(toTurnFacts({ rows: [{ status: '200', out: 2, session: 'cookrew:c', t: 'x' }, { status: 200, out: 9, session: 'cookrew:c' }] }, ['cookrew:c'])?.outputTokens).toBe(2)
    expect(toTurnFacts({ rows: [] })).toBeNull()
    // A row for another session is not this card's turn.
    expect(toTurnFacts({ rows: [{ session: 'other', status: 200, in: 1, out: 1 }] }, ['cookrew:c'])).toBeNull()
    expect(toTurnFacts({ rows: [{ session: 'cookrew:c', status: 200, in: 1, out: 1 }] }, ['cookrew:c'])?.inputTokens).toBe(1)
  })

  it('live keeps the last 20, newest first, one per card and seq', () => {
    let live: RouteDecision[] = []
    for (let i = 1; i <= 25; i += 1) live = pushLive(live, { terminalId: `c${i % 3}`, session: 's', seq: i, asked: null, group: null, model: null, effort: null, tries: 0, done: false, status: null, at: i, ttftMs: null, ms: null , rule: null})
    expect(live).toHaveLength(20)
    expect(live[0].seq).toBe(25)
    const again = pushLive(live, { ...live[0], model: 'x' })
    expect(again).toHaveLength(20)
    expect(again[0].model).toBe('x')
  })
})

describe('the follow', () => {
  it('polls one at a time while followed, lands the decision and the facts, stops when done', async () => {
    const fake = await fakeGateway()
    cleanup.push(fake.close)
    fake.answers.set(0, { route: { asked: 'group/smart', group: 'group/smart', model: 'claude/claude-sonnet-5-5', effort: 'high', tries: [{}], done: false }, seq: 1 })
    fake.answers.set(1, { route: { asked: 'group/smart', group: 'group/smart', model: 'claude/claude-sonnet-5-5', effort: 'high', tries: [{}], done: true, status: 200 }, seq: 2 })
    const decisions: RouteDecision[] = []
    const turns: string[] = []
    const d = new RouteDecisions({
      fetch: (i, init) => fetch(i, init),
      gateway: () => ({ url: fake.url, key: 'magpie-cookrew' }),
      waitSeconds: 1,
      lapFloorMs: 50,
      onDecision: (row) => decisions.push(row),
      onTurn: (id, facts) => turns.push(`${id}:${facts.model}:${facts.outputTokens}`)
    })
    d.follow('card-1')
    d.follow('card-1') // idempotent
    expect(d.following).toEqual(['card-1'])
    await sleep(250)
    expect(decisions.map((r) => [r.seq, r.done])).toEqual([[1, false], [2, true]])
    expect(turns).toEqual(['card-1:claude/claude-sonnet-5-5:3027'])
    expect(d.following).toEqual([])
    const routeCalls = fake.calls.filter((c) => c.path.includes('/v1/magpie/route'))
    expect(routeCalls.map((c) => new URL(c.path, 'http://x').searchParams.get('after'))).toEqual(['0', '1'])
    expect(routeCalls[0].path).toContain('session=cookrew%3Acard-1')
    expect(routeCalls[0].path).toContain('wait=1')
    const usageCall = fake.calls.find((c) => c.path.includes('/usage/requests'))
    expect(usageCall?.path).toContain('limit=5')
    expect(d.cardLive('card-1')?.done).toBe(true)
    expect(d.cardTurn('card-1')?.cost).toBe(0.4357)
  })

  it('a first answer with a null model is a frame, the follow goes on, the facts are read once at done (round 3)', async () => {
    const fake = await fakeGateway()
    cleanup.push(fake.close)
    fake.answers.set(0, { route: { asked: 'group/smart', group: 'group/smart', model: null, effort: null, tries: [], done: false }, seq: 1 })
    fake.answers.set(1, { route: { asked: 'group/smart', group: 'group/smart', model: 'claude/claude-sonnet-5-5', effort: 'high', tries: [{}], done: false }, seq: 2 })
    fake.answers.set(2, { route: { asked: 'group/smart', group: 'group/smart', model: 'claude/claude-sonnet-5-5', effort: 'high', tries: [{}], done: true, status: 200 }, seq: 3 })
    const frames: (string | null)[] = []
    const turns: string[] = []
    const d = new RouteDecisions({
      fetch: (i, init) => fetch(i, init),
      gateway: () => ({ url: fake.url, key: 'k' }),
      waitSeconds: 1,
      lapFloorMs: 50,
      onDecision: (row) => frames.push(row.model),
      onTurn: (id, facts) => turns.push(`${id}:${facts.outputTokens}`)
    })
    d.follow('card-1')
    await sleep(400)
    expect(frames).toEqual([null, 'claude/claude-sonnet-5-5', 'claude/claude-sonnet-5-5'])
    expect(turns).toEqual(['card-1:3027'])
    expect(fake.calls.filter((c) => c.path.includes('/usage/requests'))).toHaveLength(1)
    expect(d.following).toEqual([])
  })

  it('is silent for a card nobody follows and stops at once on unfollow', async () => {
    const fake = await fakeGateway()
    cleanup.push(fake.close)
    const d = new RouteDecisions({ fetch: (i, init) => fetch(i, init), gateway: () => ({ url: fake.url, key: 'k' }), waitSeconds: 1, onDecision: () => {}, onTurn: () => {} })
    await sleep(100)
    expect(fake.calls).toEqual([])
    d.follow('card-2')
    await sleep(10)
    d.unfollow('card-2')
    await sleep(80)
    const calls = fake.calls.length
    await sleep(120)
    expect(fake.calls.length).toBe(calls)
    expect(d.following).toEqual([])
  })

  it("asks for the harness's own session when the log is keyed by it, and never takes another session's row", async () => {
    const fake = await fakeGateway()
    cleanup.push(fake.close)
    fake.usageSessions = ['claude-own-session']
    fake.answers.set(0, { route: { asked: 'group/smart', model: 'claude/x', done: true, status: 200 }, seq: 1 })
    const turns: string[] = []
    const d = new RouteDecisions({
      fetch: (i, init) => fetch(i, init),
      gateway: () => ({ url: fake.url, key: 'k' }),
      waitSeconds: 1,
      lapFloorMs: 50,
      onDecision: () => {},
      onTurn: (id, facts) => turns.push(`${id}:${facts.model}`),
      harnessSession: (id) => (id === 'card-9' ? 'claude-own-session' : null)
    })
    d.follow('card-9')
    await sleep(200)
    expect(turns).toEqual(['card-9:claude/claude-sonnet-5-5'])
    const usageCalls = fake.calls.filter((c) => c.path.includes('/usage/requests')).map((c) => new URL(c.path, 'http://x'))
    expect(usageCalls.map((u) => u.searchParams.get('session'))).toEqual(['cookrew:card-9', 'claude-own-session'])
    // Every Usage read is ours alone: the log also holds the owner's direct Claude Code traffic.
    expect(usageCalls.map((u) => u.searchParams.get('agent'))).toEqual(['cookrew', 'cookrew'])
  })

  it('does not start when the gateway is not online', async () => {
    const fake = await fakeGateway()
    cleanup.push(fake.close)
    const d = new RouteDecisions({ fetch: (i, init) => fetch(i, init), gateway: () => null, onDecision: () => {}, onTurn: () => {} })
    d.follow('card-3')
    await sleep(50)
    expect(fake.calls).toEqual([])
    expect(d.following).toEqual([])
  })
})
