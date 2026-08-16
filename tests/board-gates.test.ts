// Activity Board — ACCEPTANCE gates B1–B7 (design §8).
//
// Relationship to tests/board-merge.test.ts: that file pins the merge RULES
// (precedence, phase mapping, windowing) as a spec for the implementer. This
// file pins the ACCEPTANCE CRITERIA — the seven gates the feature must clear
// before it ships, expressed so a machine can decide PASS/FAIL.
//
// Not every gate is machine-decidable. Three of them (B3's rendered type size,
// B6's mobile gestures, and the live half of B1/B2) need a real browser at a
// real viewport, so they appear here as `it.todo` markers pointing at the
// written procedure in docs/briefs/activity-board-qa-checklist.html. Keeping
// them in this file means the gate ledger is complete in one place: `vitest
// run tests/board-gates.test.ts` prints all seven, none can be forgotten.
//
// EXPECTED STATE BEFORE THE FEATURE LANDS: the pure gates FAIL, because
// mergeBoard/summarizeBoard still throw. That is the point — they are the
// acceptance target, written first.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BOARD_WINDOW_MS,
  mergeBoard,
  summarizeBoard,
  type BoardAgentMeta,
  type BoardPhase,
  type BoardRow
} from '../src/shared/board'
import type { TerminalActivity, TurnRecord } from '../src/shared/turn'

const NOW = 1_800_000_000_000
const WS_ACTIVE = 'ws-dev'
const WS_OTHER = 'ws-goat'

function meta(over: Partial<BoardAgentMeta> & { id: string }): BoardAgentMeta {
  return {
    name: 'Agent',
    preset: 'Claude Code',
    role: null,
    cwd: '/tmp',
    workspaceId: WS_ACTIVE,
    workspaceName: 'Cookrew Dev',
    orch: false,
    active: true,
    ...over
  }
}

function record(over: Partial<TurnRecord> & { index: number }): TurnRecord {
  return {
    prompt: 'do the thing',
    reply: 'done',
    startedAt: NOW - 60_000,
    endedAt: NOW - 30_000,
    ...over
  }
}

function activity(over: Partial<TerminalActivity> & { terminalId: string }): TerminalActivity {
  return {
    agent: true,
    phase: 'idle',
    prompt: null,
    dispatchId: null,
    pendingInput: null,
    lines: [],
    reply: null,
    glance: null,
    title: null,
    turnCount: 0,
    turnStartLine: null,
    scrollRow: null,
    tailLines: null,
    scrollBase: null,
    turnStartedAt: null,
    updatedAt: NOW,
    ...over
  }
}

function merge(over: Partial<Parameters<typeof mergeBoard>[0]> = {}): BoardRow[] {
  return mergeBoard({
    live: [],
    probe: new Map<string, BoardPhase>(),
    ledger: new Map<string, TurnRecord[]>(),
    registry: [],
    activeWorkspaceId: WS_ACTIVE,
    now: NOW,
    windowMs: BOARD_WINDOW_MS,
    ...over
  })
}

// ---------------------------------------------------------------------------
// B1 · CROSS-WORKSPACE
// Gate: "an agent in an INACTIVE workspace that completes a turn shows up on
// the board within 5s."
//
// Split honestly: the 5s is an end-to-end latency budget that only a running
// app can prove (SSE → render). What IS decidable here is the precondition
// the latency rides on — the merge must ADMIT an inactive-workspace row at
// all. If this half fails, no amount of SSE tuning makes the gate pass.
// ---------------------------------------------------------------------------
describe('B1 · cross-workspace rows are admitted (merge half)', () => {
  it('emits a row for an agent whose workspace is NOT the active one', () => {
    const rows = merge({
      ledger: new Map([['t-other', [record({ index: 7, endedAt: NOW - 4_000, seenAt: NOW })]]]),
      registry: [meta({ id: 't-other', workspaceId: WS_OTHER, workspaceName: 'GOAT Team' })]
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].terminalId).toBe('t-other')
    expect(rows[0].workspace.active).toBe(false)
    expect(rows[0].workspace.name).toBe('GOAT Team')
  })

  it('shows a just-completed inactive-workspace turn alongside active ones', () => {
    // The realistic B1 scenario: two workspaces, the OTHER one finishes last.
    const rows = merge({
      ledger: new Map([
        ['here', [record({ index: 1, endedAt: NOW - 60_000, seenAt: NOW })]],
        ['there', [record({ index: 1, endedAt: NOW - 1_000, seenAt: NOW })]]
      ]),
      registry: [
        meta({ id: 'here' }),
        meta({ id: 'there', workspaceId: WS_OTHER, workspaceName: 'GOAT Team' })
      ]
    })
    expect(rows.map((r) => r.terminalId)).toEqual(['there', 'here'])
  })

  it.todo('B1-live: complete a turn in an inactive workspace → row appears within 5s (browser)')
})

// ---------------------------------------------------------------------------
// B2 · ORDERING
// Gate: "strict lastActivityAt DESC; a new turn jumps to row 1 with no refresh."
// The ordering half is fully decidable; the no-refresh half is SSE behaviour.
// ---------------------------------------------------------------------------
describe('B2 · strict lastActivityAt descending', () => {
  it('orders a shuffled set strictly by lastActivityAt, every adjacent pair', () => {
    // Fuzz-ish: 25 rows at scattered times, inserted in a deliberately wrong
    // order. A partially-correct comparator (e.g. one that groups by phase)
    // survives a 3-row test but not this one.
    const offsets = Array.from({ length: 25 }, (_, i) => ((i * 7919) % 1000) * 60_000 + 1_000)
    const ledger = new Map<string, TurnRecord[]>()
    const registry: BoardAgentMeta[] = []
    offsets.forEach((off, i) => {
      ledger.set(`t${i}`, [record({ index: 1, endedAt: NOW - off, seenAt: NOW })])
      registry.push(meta({ id: `t${i}` }))
    })
    const rows = merge({ ledger, registry, windowMs: 90 * 24 * 3600_000 })
    expect(rows.length).toBe(25)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].lastActivityAt).toBeGreaterThanOrEqual(rows[i].lastActivityAt)
    }
  })

  it('puts a brand-new in-flight turn at row 1', () => {
    // "jumps to the first row" — the merge must key an in-flight row off the
    // live turn start, not off the last COMPLETED turn (which is older).
    const rows = merge({
      live: [activity({ terminalId: 'fresh', phase: 'thinking', turnStartedAt: NOW - 500 })],
      ledger: new Map([
        ['fresh', [record({ index: 1, endedAt: NOW - 10 * 3600_000 })]],
        ['stale', [record({ index: 1, endedAt: NOW - 60_000, seenAt: NOW })]]
      ]),
      registry: [meta({ id: 'fresh' }), meta({ id: 'stale' })]
    })
    expect(rows[0].terminalId).toBe('fresh')
    expect(rows[0].lastActivityAt).toBe(NOW - 500)
  })

  it('does not float waiting above a more recent row (ordering is time only)', () => {
    const rows = merge({
      live: [
        activity({ terminalId: 'stuck', phase: 'waiting', turnStartedAt: NOW - 3600_000 }),
        activity({ terminalId: 'fresh', phase: 'thinking', turnStartedAt: NOW - 5_000 })
      ],
      ledger: new Map([
        ['stuck', [record({ index: 1, endedAt: NOW - 3600_000 })]],
        ['fresh', [record({ index: 1, endedAt: NOW - 5_000 })]]
      ]),
      registry: [meta({ id: 'stuck' }), meta({ id: 'fresh' })]
    })
    expect(rows.map((r) => r.terminalId)).toEqual(['fresh', 'stuck'])
  })

  it.todo('B2-live: a new turn reaches row 1 with no manual refresh (browser + SSE)')
})

// ---------------------------------------------------------------------------
// B3 · WAITING VISIBILITY
// Gate: "in a REAL 1920×1080 render, the waiting row's primary title is ≥26px
// and it is counted in the top strip."
//
// The 26px is a rendered-pixel fact — it needs a real window (see the headless
// clamp trap in the checklist). The COUNT half is pure and decidable here, and
// it is the half that silently regresses: a waiting row that the summary
// forgets is invisible in the aggregate even when the row itself renders.
// ---------------------------------------------------------------------------
describe('B3 · waiting is counted in the header strip (count half)', () => {
  it('counts every waiting row, from any layer', () => {
    const rows = merge({
      live: [activity({ terminalId: 'w1', phase: 'waiting', turnStartedAt: NOW - 1_000 })],
      probe: new Map([['w2', 'waiting' as BoardPhase]]),
      ledger: new Map([
        ['w1', [record({ index: 1, endedAt: NOW - 1_000 })]],
        ['w2', [record({ index: 1, endedAt: NOW - 2_000 })]],
        ['ok', [record({ index: 1, endedAt: NOW - 3_000, seenAt: NOW })]]
      ]),
      registry: [
        meta({ id: 'w1' }),
        meta({ id: 'w2', workspaceId: WS_OTHER, workspaceName: 'GOAT Team' }),
        meta({ id: 'ok' })
      ]
    })
    const summary = summarizeBoard(rows)
    expect(summary.waiting).toBe(2)
    expect(rows.filter((r) => r.phase === 'waiting')).toHaveLength(2)
  })

  it('never reports a waiting count the rows cannot account for', () => {
    // Guards the inverse failure: a header that counts something not on screen.
    const rows = merge({
      live: [activity({ terminalId: 'a', phase: 'thinking', turnStartedAt: NOW - 1_000 })],
      ledger: new Map([['a', [record({ index: 1, endedAt: NOW - 1_000 })]]]),
      registry: [meta({ id: 'a' })]
    })
    const summary = summarizeBoard(rows)
    expect(summary.waiting).toBe(rows.filter((r) => r.phase === 'waiting').length)
    expect(summary.working).toBe(rows.filter((r) => r.phase === 'working').length)
  })

  it.todo('B3-render: REAL 1920×1080 screenshot — waiting title cap-height ≥26px (NOT headless 500px)')
})

// ---------------------------------------------------------------------------
// B4 · HONEST DEGRADATION
// Gate: "a ledger-only row never shows a live tail; `source` is legible in UI."
//
// The structural half is strong here: BoardRow carries NO channel for live
// tail text at all (no `lines`), so the only way a probe/ledger row could show
// one is if the UI reached past the row into /api/activity. What this file can
// pin is that `source` is always set truthfully, and that a probe row's text
// comes from the ledger rather than being invented.
// ---------------------------------------------------------------------------
describe('B4 · every row declares its fidelity truthfully', () => {
  it('labels each row with the layer that actually produced its phase', () => {
    const rows = merge({
      live: [activity({ terminalId: 'l', phase: 'thinking', turnStartedAt: NOW - 1_000 })],
      probe: new Map([['p', 'working' as BoardPhase]]),
      ledger: new Map([
        ['l', [record({ index: 1, endedAt: NOW - 5_000 })]],
        ['p', [record({ index: 1, endedAt: NOW - 6_000 })]],
        ['g', [record({ index: 1, endedAt: NOW - 7_000, seenAt: NOW })]]
      ]),
      registry: [
        meta({ id: 'l' }),
        meta({ id: 'p', workspaceId: WS_OTHER, workspaceName: 'GOAT Team' }),
        meta({ id: 'g', workspaceId: WS_OTHER, workspaceName: 'GOAT Team' })
      ]
    })
    const by = new Map(rows.map((r) => [r.terminalId, r]))
    expect(by.get('l')?.source).toBe('live')
    expect(by.get('p')?.source).toBe('probe')
    expect(by.get('g')?.source).toBe('ledger')
    for (const r of rows) expect(['live', 'probe', 'ledger']).toContain(r.source)
  })

  it('a probe row carries the LAST KNOWN ledger text, never an invented prompt', () => {
    const rows = merge({
      probe: new Map([['t1', 'working' as BoardPhase]]),
      ledger: new Map([
        ['t1', [record({ index: 3, prompt: 'ship the migration', title: 'Ship migration' })]]
      ]),
      registry: [meta({ id: 't1', workspaceId: WS_OTHER, workspaceName: 'GOAT Team' })]
    })
    expect(rows[0].source).toBe('probe')
    expect(rows[0].task.summary).toBe('ship the migration')
    expect(rows[0].task.title).toBe('Ship migration')
  })

  it('a non-live row never claims an in-flight turn it cannot observe', () => {
    // endedAt === null means "running now, we are watching it". Only the live
    // layer can honestly say that; a ledger row must report the turn it has.
    const rows = merge({
      ledger: new Map([['t1', [record({ index: 1, endedAt: NOW - 5_000, seenAt: NOW })]]]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows[0].source).toBe('ledger')
    expect(rows[0].task.endedAt).not.toBeNull()
  })

  it.todo('B4-ui: probe/ledger rows render no live tail, and `source` is visually distinguishable')
})

// ---------------------------------------------------------------------------
// B5 · NO REGRESSION
// Gate as written: "/api/activity response is byte-for-byte unchanged."
//
// FINDING (prep): taken literally this gate can never pass — /api/activity is
// live data (phase, lines, updatedAt all move), so two reads a second apart
// already differ. Measured on the pre-feature build: two samples 1.2s apart
// produced different sha256. The testable, meaningful form of the gate is
// SCHEMA identity: same keys, same insertion order, same types, per element —
// which is exactly what breaks if the board work reuses TerminalActivity as a
// carrier. That frozen key order was captured from the PRE-feature build into
// tests/fixtures/activity-baseline.json.
// ---------------------------------------------------------------------------

/** TerminalActivity key order, frozen from the pre-feature build (2026-08-06). */
const ACTIVITY_KEYS_FROZEN = [
  'terminalId',
  'agent',
  'phase',
  'prompt',
  'pendingInput',
  'lines',
  'reply',
  'glance',
  'title',
  'turnCount',
  'turnStartedAt',
  'turnStartLine',
  'scrollRow',
  'scrollBase',
  'tailLines',
  'updatedAt'
] as const

describe('B5 · /api/activity schema is frozen', () => {
  const fixture = path.join(__dirname, 'fixtures', 'activity-baseline.json')

  it('the captured pre-feature baseline still matches the frozen key order', () => {
    const rows = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, unknown>[]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(Object.keys(row)).toEqual([...ACTIVITY_KEYS_FROZEN])
    }
  })

  it('the /api/activity route still serves turns.list() unwrapped', () => {
    // The regression this catches: someone adds board data to the activity
    // payload ("it is already being polled") and every canvas card reparses.
    const src = readFileSync(path.join(__dirname, '..', 'src', 'main', 'mobile-api.ts'), 'utf8')
    const route = src.match(/p === "\/api\/activity"\)\s*\{([\s\S]*?)\}/)
    expect(route, '/api/activity route not found in mobile-api.ts').toBeTruthy()
    expect(route![1]).toContain('turns.list()')
    expect(route![1]).not.toMatch(/board/i)
  })

  // Opt-in: needs the app running. BOARD_GATES_LIVE=1 npx vitest run tests/board-gates.test.ts
  const live = process.env.BOARD_GATES_LIVE === '1' ? it : it.skip
  live('live /api/activity matches the frozen schema element-for-element', async () => {
    const res = await fetch('http://127.0.0.1:8639/api/activity')
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Record<string, unknown>[]
    expect(Array.isArray(rows)).toBe(true)
    for (const row of rows) expect(Object.keys(row)).toEqual([...ACTIVITY_KEYS_FROZEN])
  })

  it.todo('B5-ui: Roster tab RECOVER still recovers (exact-context gate) — see checklist')
})

// ---------------------------------------------------------------------------
// B6 · MOBILE — browser only (CDP 9245 or claude-in-chrome; never a canvas
// browser pointed at :8639/:8643/:5173, the self-embed guard blocks it).
// ---------------------------------------------------------------------------
describe('B6 · mobile canvas/board switch', () => {
  it.todo('B6-a: CANVAS|BOARD selection persists across reload (sessionStorage)')
  it.todo('B6-b: tapping a board row opens the existing #popout')
  it.todo('B6-c: a cross-workspace row offers SWITCH & OPEN, and it works')
})

// ---------------------------------------------------------------------------
// B7 · COST
// Gate: "probe duty cycle < 5%". Baseline quoted in the design: 107ms per
// sweep of 19 sessions on a 3s period = 3.6%.
//
// FINDING (prep, measured on this machine): the gate's outcome is decided by
// HOW the sweep is issued, not by tmux. One `tmux capture-pane` process per
// session costs ~127ms median for 19 sessions (4.2%, and a cold run hit
// 167ms = 5.6%, over budget) because it is dominated by process spawn. A
// SINGLE tmux invocation with `;`-separated capture-pane commands returns
// byte-identical output (22047 chars both ways) in ~7ms — 0.25%, a 17×
// saving. The per-process form also scales into the wall: at ~6.7ms/session
// it breaches 150ms (5% of 3s) at roughly 22 sessions, and this machine
// already runs 19.
// ---------------------------------------------------------------------------

/** Duty cycle of a periodic sweep, as a fraction. */
export function dutyCycle(sweepMs: number, periodMs: number): number {
  return sweepMs / periodMs
}

const PROBE_PERIOD_MS = 3_000
const PROBE_BUDGET = 0.05

describe('B7 · probe duty cycle stays under 5%', () => {
  it('accepts the design baseline (107ms / 3s)', () => {
    expect(dutyCycle(107, PROBE_PERIOD_MS)).toBeLessThan(PROBE_BUDGET)
  })

  it('rejects a sweep that exceeds the budget', () => {
    expect(dutyCycle(151, PROBE_PERIOD_MS)).toBeGreaterThan(PROBE_BUDGET)
  })

  it('documents the headroom the per-process form actually has', () => {
    // Measured: ~6.7ms per session when each capture-pane is its own process.
    const perSessionMs = 6.7
    const maxSweepMs = PROBE_BUDGET * PROBE_PERIOD_MS
    const breachAt = Math.floor(maxSweepMs / perSessionMs)
    expect(breachAt).toBeLessThan(30) // i.e. NOT comfortable — batch instead
    expect(dutyCycle(perSessionMs * 19, PROBE_PERIOD_MS)).toBeLessThan(PROBE_BUDGET)
    // …but only just: one slow sweep crosses it.
    expect(dutyCycle(perSessionMs * 23, PROBE_PERIOD_MS)).toBeGreaterThan(PROBE_BUDGET)
  })

  // Opt-in: measures the REAL sweep against the live tmux server.
  const live = process.env.BOARD_GATES_LIVE === '1' ? it : it.skip
  live('measured sweep of the live tmux server is under budget', async () => {
    const { execFileSync } = await import('node:child_process')
    const names = execFileSync('tmux', ['-L', 'cookrew', 'list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8'
    })
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(names.length).toBeGreaterThan(0)

    const args = ['-L', 'cookrew']
    names.forEach((n, i) => {
      if (i) args.push(';')
      args.push('capture-pane', '-p', '-t', n)
    })
    const started = performance.now()
    execFileSync('tmux', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const sweepMs = performance.now() - started

    // eslint-disable-next-line no-console
    console.log(
      `[B7] ${names.length} sessions, sweep ${sweepMs.toFixed(1)}ms, ` +
        `duty ${(dutyCycle(sweepMs, PROBE_PERIOD_MS) * 100).toFixed(2)}%`
    )
    expect(dutyCycle(sweepMs, PROBE_PERIOD_MS)).toBeLessThan(PROBE_BUDGET)
  })

  it.todo('B7-impl: confirm the shipped probe batches its sweep into ONE tmux invocation')
})
