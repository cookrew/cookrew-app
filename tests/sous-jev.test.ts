// THE FIVE-QUESTION JEV (E2E round, lane jev) — fixture-driven against a
// node:http fake gateway. No live Jev exists on this machine: the 404/400
// bodies in tests/fixtures/magpie/ are the recorded error contract, the
// success body follows magpie's own answer shape (report-hp-facts §1).
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allowedSet,
  askJev,
  BADGE_JEV,
  BADGE_TIMED_OUT,
  buildJevRequest,
  confidenceOf,
  createJevDecider,
  ESCAPE,
  jevEnabled,
  mergeJev,
  parseJevAnswers,
  T_CHOICE
} from '../src/main/sous-jev'
import { createSousBreaker } from '../src/main/sous-breaker'
import { decide, type DecideCandidate } from '../src/shared/sous-decide'
import { SousController, type SousControlDeps } from '../src/main/sous-control'
import type { IntentRoster } from '../src/shared/sous-intent'

const NOW = Date.parse('2026-10-12T09:00:00Z')
const H = 3_600_000
const card = (patch: Partial<DecideCandidate> & Pick<DecideCandidate, 'id'>): DecideCandidate => ({
  name: patch.id[0].toUpperCase() + patch.id.slice(1),
  workspaceId: 'ws',
  cwd: '/repo',
  role: null,
  orch: false,
  phase: 'done',
  contextFull: false,
  lastTask: null,
  lastActivityAt: NOW - H,
  ...patch
})
const crew = [
  card({ id: 'conductor', orch: true, phase: 'working', lastTask: 'orchestrating the release' }),
  card({ id: 'forge', role: 'Developer', lastTask: 'README install section → EN', lastActivityAt: NOW - 2 * H }),
  card({ id: 'tinker', role: 'Bugfix', lastTask: 'cable signal QA', lastActivityAt: NOW - 40 * 60_000 }),
  card({ id: 'guest', role: 'Developer', served: true }),
  card({ id: 'full', role: 'Developer', contextFull: true })
]
const SENTENCE = 'Make the install section of README English and add a test'
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures/magpie', name), 'utf8')
const tinkerLabel = (labels: Map<string, string>): string => [...labels.entries()].find(([, id]) => id === 'tinker')?.[0] ?? ''

const ctx = { candidates: crew, workdir: '/repo', now: NOW }

describe('the flag', () => {
  it('is off by default, and off means decide() and the controller are byte-identical to today (no badge, no call)', async () => {
    expect(jevEnabled({})).toBe(false)
    expect(jevEnabled({ COOKREW_SOUS_JEV: '0' })).toBe(false)
    expect(jevEnabled({ COOKREW_SOUS_JEV: '1' })).toBe(true)
    const draft = decide(SENTENCE, ctx)
    const h = controller()
    const r = await h.sous.handle({ text: SENTENCE, surface: 'canvas', box: true })
    // the controller adds token / holdMs / sentence and owns mode and route; everything else is decide()'s draft, byte for byte
    const { mode: ruleMode, route: _route, ...fromRules } = draft
    void _route
    expect(r.decision).toEqual({ ...fromRules, mode: ruleMode, route: null, token: 'tok-1', holdMs: 2500, sentence: SENTENCE })
    expect(JSON.stringify(r.decision)).not.toContain('badge')
  })
})

describe('the request', () => {
  it('one body: group/jevs, the five questions plus domain, labels never ids, the escape, no rubric', () => {
    const allowed = allowedSet(SENTENCE, crew, '/repo')
    expect(allowed.map((c) => c.id).sort()).toEqual(['forge', 'tinker'])
    const req = buildJevRequest({ sentence: SENTENCE, lang: 'en', repo: 'repo', candidates: allowed, recent: ['3m ago: Fix Typo → ask Forge'], now: NOW, token: 't' })
    expect(req.body.model).toBe('group/jevs')
    const questions = req.body.questions as Record<string, Record<string, unknown>>
    expect(Object.keys(questions)).toEqual(['path', 'harness', 'human', 'question', 'exposure', 'domain'])
    expect(JSON.stringify(req.body)).not.toContain('rubric')
    expect(JSON.stringify(req.body)).not.toMatch(/"forge"|"tinker"/)
    const path = questions.path.criteria as Record<string, string>
    expect(Object.keys(path)).toContain(ESCAPE)
    expect(Object.keys(path)).toContain('new claude card')
    expect(Object.keys(path).some((k) => k.startsWith('Forge · Developer · idle 2h · last: README'))).toBe(true)
    expect(req.labels.get(tinkerLabel(req.labels))).toBe('tinker')
    expect(questions.exposure.type).toBe('score')
    expect(Array.isArray(questions.exposure.criteria)).toBe(true)
    expect(typeof questions.exposure.instructions).toBe('string')
    expect(questions.human.type).toBe('noul')
    expect((req.body.state as Record<string, string>).recent).toContain('ask Forge')
  })

  it('a non-routable harness is not offered as a new card when a default route is set; more than eight candidates are cut by overlap', () => {
    const req = buildJevRequest({ sentence: SENTENCE, lang: 'en', repo: 'repo', candidates: [], routing: { defaultSet: true, routable: { Pi: false } }, recent: [], now: NOW, token: 't' })
    expect([...req.harnessLabels.keys()]).toEqual(['new claude card', 'new codex card'])
    const many = Array.from({ length: 20 }, (_, i) => card({ id: `c${i}`, lastTask: i === 19 ? 'the README install section' : `turn ${i}` }))
    const allowed = allowedSet(SENTENCE, many, '/repo')
    expect(allowed).toHaveLength(8)
    expect(allowed[0].id).toBe('c19')
  })
})

describe('the answers', () => {
  it('confidence is taken as given, or derived from probabilities as magpie does', () => {
    expect(confidenceOf([0.87, 0.1, 0.03])).toBeCloseTo(0.805, 3)
    expect(confidenceOf([1 / 3, 1 / 3, 1 / 3])).toBe(0)
    expect(confidenceOf([1, 0])).toBe(1)
    const parsed = parseJevAnswers({ answers: { path: { choice: 'x', probabilities: { x: 0.87, y: 0.1, z: 0.03 } }, human: { noul: 0.2, confidence: 0.9 } } })
    expect(parsed.path?.confidence).toBeCloseTo(0.805, 3)
    expect(parsed.path?.margin).toBeCloseTo(0.77, 3)
    expect(parsed.human).toEqual({ noul: 0.2, confidence: 0.9 })
  })

  it('a malformed body throws', () => {
    expect(() => parseJevAnswers(null)).toThrow(/malformed/)
    expect(() => parseJevAnswers({})).toThrow(/no answers/)
    expect(() => parseJevAnswers({ answers: { path: 'x' } })).toThrow(/malformed/)
    expect(() => parseJevAnswers({ answers: { path: { choice: 'x' } } })).toThrow(/no confidence/)
  })
})

describe('the merge contract', () => {
  const allowed = allowedSet(SENTENCE, crew, '/repo')
  const req = buildJevRequest({ sentence: SENTENCE, lang: 'en', repo: 'repo', candidates: allowed, recent: [], now: NOW, token: 't' })
  const draft0 = decide(SENTENCE, ctx)
  const ok = (over: Record<string, unknown> = {}) => ({
    path: { choice: tinkerLabel(req.labels), confidence: 0.95, margin: 0.6 },
    harness: { choice: 'unclear', confidence: 0.5 },
    human: { noul: 0.1, confidence: 0.9 },
    question: { noul: 0.05, confidence: 0.9 },
    exposure: { score: 1, confidence: 0.9 },
    domain: { choice: 'repo', confidence: 0.9 },
    ...over
  })

  it('a confident path inside the allowed set re-targets, with the old target demoted to an alternate, and ticks on a wide margin', () => {
    expect(draft0.kind).toBe('ask')
    const m = mergeJev(draft0, ok(), req, undefined, SENTENCE)
    expect(m.draft.kind).toBe('ask')
    if (m.draft.kind === 'ask') {
      expect(m.draft.target.id).toBe('tinker')
      expect(m.draft.alternates[0]).toMatchObject({ kind: 'ask', id: 'forge' })
    }
    expect(m.mode).toBe('ticking')
    expect(m.badge).toBe(BADGE_JEV)
  })

  it('low confidence leaves the draft as it was and pauses; a narrow margin pauses too; a label outside the allowed set changes nothing', () => {
    const low = mergeJev(draft0, ok({ path: { choice: tinkerLabel(req.labels), confidence: 0.6 } }), req, undefined, SENTENCE)
    expect(low.draft.kind === 'ask' && low.draft.target.id).toBe('forge')
    expect(low.mode).toBe('paused')
    const narrow = mergeJev(draft0, ok({ path: { choice: tinkerLabel(req.labels), confidence: 0.9, margin: 0.05 } }), req, undefined, SENTENCE)
    expect(narrow.draft.kind === 'ask' && narrow.draft.target.id).toBe('tinker')
    expect(narrow.mode).toBe('paused')
    expect(narrow.reasons).toContain('margin narrow')
    const stranger = mergeJev(draft0, ok({ path: { choice: 'Guest · Developer · idle 1h · last: —', confidence: 0.99, margin: 0.9 } }), req, undefined, SENTENCE)
    expect(stranger.draft.kind === 'ask' && stranger.draft.target.id).toBe('forge')
  })

  it('human ≥ 0.7, the escape, or exposure 3 override the path into a question back; question ≥ 0.7 too', () => {
    expect(mergeJev(draft0, ok({ human: { noul: 0.8, confidence: 0.9 } }), req, undefined, SENTENCE).draft.kind).toBe('question')
    expect(mergeJev(draft0, ok({ path: { choice: ESCAPE, confidence: 0.9, margin: 0.5 } }), req, undefined, SENTENCE).draft.kind).toBe('question')
    expect(mergeJev(draft0, ok({ exposure: { score: 3, confidence: 0.9 } }), req, undefined, SENTENCE).draft.kind).toBe('question')
    expect(mergeJev(draft0, ok({ question: { noul: 0.75, confidence: 0.9 } }), req, undefined, SENTENCE).draft.kind).toBe('question')
    expect(mergeJev(draft0, ok({ human: { noul: 0.69, confidence: 0.9 } }), req, undefined, SENTENCE).draft.kind).toBe('ask')
  })

  it('exposure is only ever raised, never lowered; raised to 2 pauses the hold', () => {
    const raised = mergeJev(draft0, ok({ exposure: { score: 2, confidence: 0.9 } }), req, undefined, SENTENCE)
    expect(raised.draft.exposure).toBe(2)
    expect(raised.mode).toBe('paused')
    const pushy = decide('push the install section of README to the branch', ctx)
    expect(pushy.exposure).toBe(2)
    const lowered = mergeJev(pushy, ok({ exposure: { score: 0, confidence: 0.9 } }), req, undefined, 'push the install section of README to the branch')
    expect(lowered.draft.exposure).toBe(2)
  })

  it('harness shape applies to a recruit only, through routability', () => {
    const recruit = decide('compose notes for the changelog file', ctx)
    expect(recruit.kind).toBe('recruit')
    const req2 = buildJevRequest({ sentence: 'compose notes for the changelog file', lang: 'en', repo: 'repo', candidates: allowed, recent: [], now: NOW, token: 't' })
    const light = mergeJev(recruit, ok({ path: { choice: 'new pi card', confidence: 0.5 }, harness: { choice: 'quick/small/explain', confidence: 0.9 } }), req2, undefined, 'compose notes for the changelog file')
    expect(light.draft.kind === 'recruit' && light.draft.harness).toBe('Pi')
    const routed = mergeJev(recruit, ok({ path: { choice: 'new pi card', confidence: 0.5 }, harness: { choice: 'quick/small/explain', confidence: 0.9 } }), req2, { defaultSet: true, routable: { Pi: false } }, 'compose notes for the changelog file')
    expect(routed.draft.kind === 'recruit' && routed.draft.harness).toBe('Claude Code')
    // the harness question does not touch an ask
    const ask = mergeJev(draft0, ok({ harness: { choice: 'quick/small/explain', confidence: 0.99 } }), req, undefined, SENTENCE)
    expect(ask.draft.kind).toBe('ask')
  })
})

describe('the call, against a fake gateway', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const gateway = async (handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) => {
    const seen: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown>; url: string }> = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        seen.push({ headers: req.headers, body: body ? (JSON.parse(body) as Record<string, unknown>) : {}, url: req.url ?? '' })
        handler(req, body, res)
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    return { v1: `http://127.0.0.1:${port}/v1`, seen }
  }
  const json = (res: http.ServerResponse, status: number, body: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body)
  }
  const request = () => buildJevRequest({ sentence: SENTENCE, lang: 'en', repo: 'repo', candidates: allowedSet(SENTENCE, crew, '/repo'), recent: [], now: NOW, token: 'tok-1' })
  const success = (label: string): string => JSON.stringify({ model: 'group/jevs', answers: { path: { choice: label, probabilities: { [label]: 0.95, other: 0.05 } }, harness: { choice: 'unclear', confidence: 0.4 }, human: { noul: 0.1, confidence: 0.9 }, question: { noul: 0.05, confidence: 0.9 }, exposure: { score: 1, confidence: 0.8 }, domain: { choice: 'repo', confidence: 0.9 } }, usage: { input_tokens: 10, output_tokens: 2 } })
  const deps = (v1: string, over: Partial<Parameters<typeof askJev>[2]> = {}) => ({ gateway: () => ({ v1 }), key: () => 'magpie-sous', breaker: createSousBreaker(), deadlineMs: 300, ...over })

  it('success: POST /v1/systemone with the bearer and the decide session, answers parsed', async () => {
    const req = request()
    const g = await gateway((_r, _b, res) => json(res, 200, success(tinkerLabel(req.labels))))
    const out = await askJev(req, 'tok-1', deps(g.v1))
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.answers.path?.choice).toBe(tinkerLabel(req.labels))
    expect(g.seen[0].url).toBe('/v1/systemone')
    expect(g.seen[0].headers.authorization).toBe('Bearer magpie-sous')
    expect(g.seen[0].headers['x-magpie-session']).toBe('sous:decide:tok-1')
    expect(g.seen[0].body.model).toBe('group/jevs')
  })

  it('timeout: the soft deadline answers "timed out" and the echo is never blocked past it', async () => {
    const g = await gateway((_r, _b, res) => setTimeout(() => json(res, 200, success('x')), 1500))
    const t0 = Date.now()
    const out = await askJev(request(), 'tok-1', deps(g.v1, { deadlineMs: 200 }))
    expect(out).toMatchObject({ ok: false, reason: 'timed out' })
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('404 no Jev provider and the two 400s are reasons carrying magpie\'s recorded message; a malformed body is a reason too', async () => {
    for (const [file, status, needle] of [
      ['systemone-404-no-jev-provider.json', 404, 'no Jev provider'],
      ['systemone-400-no-model.json', 400, 'names no model'],
      ['systemone-400-chat-group.json', 400, 'decision models']
    ] as const) {
      const g = await gateway((_r, _b, res) => json(res, status, fixture(file)))
      const out = await askJev(request(), 'tok-1', deps(g.v1))
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toContain(needle)
    }
    const g = await gateway((_r, _b, res) => json(res, 200, '{"model":"group/jevs"}'))
    const out = await askJev(request(), 'tok-1', deps(g.v1))
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/malformed/) })
  })

  it('the breaker opens after three failures and the fourth call never reaches the gateway', async () => {
    let hits = 0
    const g = await gateway((_r, _b, res) => {
      hits += 1
      json(res, 404, fixture('systemone-404-no-jev-provider.json'))
    })
    const d = deps(g.v1, { breaker: createSousBreaker() })
    for (let i = 0; i < 3; i++) await askJev(request(), 'tok-1', d)
    const out = await askJev(request(), 'tok-1', d)
    expect(out).toMatchObject({ ok: false, reason: 'breaker open' })
    expect(hits).toBe(3)
  })

  it('end to end through the controller: a confident answer re-targets with the jev badge; a timeout leaves the rule draft badged "rule (timed out)"', async () => {
    // 0.95/0.05 derives to confidence 0.9 ≥ T_CHOICE with margin 0.9; 0.9/0.1 would derive to 0.8 and (correctly) hold the rule draft paused
    const g = await gateway((_r, body, res) => {
      const labels = Object.keys(((JSON.parse(body) as { questions: { path: { criteria: Record<string, string> } } }).questions.path.criteria))
      const tinker = labels.find((l) => l.startsWith('Tinker')) ?? labels[0]
      json(res, 200, success(tinker))
    })
    const jev = createJevDecider({ ...deps(g.v1), recent: () => [] })
    const h = controller({ jev })
    const r = await h.sous.handle({ text: SENTENCE, surface: 'canvas', box: true })
    expect(r.decision).toMatchObject({ kind: 'ask', target: { id: 'tinker' }, badge: BADGE_JEV, mode: 'ticking' })
    const slow = await gateway((_r, _b, res) => setTimeout(() => json(res, 200, success('x')), 1500))
    const late = createJevDecider({ ...deps(slow.v1, { deadlineMs: 150 }), recent: () => [] })
    const h2 = controller({ jev: late })
    const r2 = await h2.sous.handle({ text: SENTENCE, surface: 'canvas', box: true })
    expect(r2.decision).toMatchObject({ kind: 'ask', target: { id: 'forge' }, badge: BADGE_TIMED_OUT, mode: 'ticking' })
    expect(T_CHOICE).toBe(0.85)
  })
})

// ── the controller harness ──────────────────────────────────────────────
const roster: IntentRoster = {
  agents: [
    { id: 'conductor', name: 'Conductor', workspaceId: 'ws', workspaceName: 'Dev', orch: true },
    { id: 'forge', name: 'Forge', workspaceId: 'ws', workspaceName: 'Dev', role: 'Developer' },
    { id: 'tinker', name: 'Tinker', workspaceId: 'ws', workspaceName: 'Dev', role: 'Bugfix' }
  ],
  workspaces: [{ id: 'ws', name: 'Dev' }],
  presets: ['Claude Code', 'Codex', 'OpenCode', 'Pi', 'Shell']
}
function controller(extra: Partial<NonNullable<SousControlDeps['decide']>> = {}) {
  const calls: string[] = []
  const deps: SousControlDeps = {
    roster: () => roster,
    activeWorkspaceId: () => 'ws',
    switchWorkspace: () => undefined,
    createTerminal: ({ name }) => ({ id: 'new', name }),
    createBrowser: async () => undefined,
    connect: () => undefined,
    rename: () => undefined,
    submit: async () => undefined,
    ui: (command) => calls.push(`ui ${command.kind}`),
    now: () => NOW,
    decide: {
      candidates: () => crew,
      workdir: () => '/repo',
      recruit: ({ name }) => ({ id: 'recruited', name }),
      deliver: async () => ({ dispatchId: 'd' }),
      token: () => 'tok-1',
      ...extra
    }
  }
  return { calls, sous: new SousController(deps) }
}
