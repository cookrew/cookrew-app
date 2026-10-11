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
      return res.end(JSON.stringify({ rows: [{ t: '2026-10-11T06:13:57.702Z', served: 'claude/claude-sonnet-5-5', model: 'group/smart', in: 32, out: 3027, cost: 0.4357, session: known ? asked : 'somebody-else' }], total: 1 }))
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
    expect(d).toEqual({ terminalId: 'card-1', session: 'cookrew:card-1', seq: 4, asked: 'group/smart', group: 'group/smart', model: 'deepseek/deepseek-chat', effort: 'high', tries: 2, done: false, status: null, at: 5 })
  })

  it('the usage row becomes turn facts', () => {
    expect(toTurnFacts({ rows: [{ t: '2026-10-11T06:13:57.702Z', served: 'claude/claude-sonnet-5-5', in: 32, out: 3027, cost: 0.4357 }] })).toEqual({
      model: 'claude/claude-sonnet-5-5', inputTokens: 32, outputTokens: 3027, cost: 0.4357, at: Date.parse('2026-10-11T06:13:57.702Z')
    })
    expect(toTurnFacts({ rows: [] })).toBeNull()
    // A row for another session is not this card's turn.
    expect(toTurnFacts({ rows: [{ session: 'other', in: 1 }] }, ['cookrew:c'])).toBeNull()
    expect(toTurnFacts({ rows: [{ session: 'cookrew:c', in: 1 }] }, ['cookrew:c'])?.inputTokens).toBe(1)
  })

  it('live keeps the last 20, newest first, one per card and seq', () => {
    let live: RouteDecision[] = []
    for (let i = 1; i <= 25; i += 1) live = pushLive(live, { terminalId: `c${i % 3}`, session: 's', seq: i, asked: null, group: null, model: null, effort: null, tries: 0, done: false, status: null, at: i })
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
    expect(d.cardLive('card-1')?.done).toBe(true)
    expect(d.cardTurn('card-1')?.cost).toBe(0.4357)
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
    const usage = fake.calls.filter((c) => c.path.includes('/usage/requests')).map((c) => new URL(c.path, 'http://x').searchParams.get('session'))
    expect(usage).toEqual(['cookrew:card-9', 'claude-own-session'])
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
