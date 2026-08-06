// The Activity Board's merge rules, pinned before the collectors exist.
//
// Everything the board promises that is NOT obvious from the types lives
// here: precedence between the three fidelity layers, the timeline-only
// ordering (waiting rows are deliberately NOT floated), the windowing that
// keeps 189 dormant agents off the screen, and the honesty rule that a
// probe-sourced row never claims to know the prompt of its live turn.

import { describe, expect, it } from 'vitest'
import {
  BOARD_SUMMARY_MAX,
  BOARD_WINDOW_MS,
  ledgerPhase,
  livePhase,
  mergeBoard,
  stripSystemWrappers,
  summarizeBoard,
  taskSummary,
  taskText,
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

/** Minimal well-formed input; each test overrides just what it exercises. */
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

describe('livePhase — tracker vocabulary → board vocabulary', () => {
  it("maps 'replied' to unread, because the tracker demotes to idle on view", () => {
    expect(livePhase(activity({ terminalId: 't', phase: 'replied' }))).toBe('unread')
    expect(livePhase(activity({ terminalId: 't', phase: 'idle' }))).toBe('done')
  })

  it('maps thinking/waiting straight through', () => {
    expect(livePhase(activity({ terminalId: 't', phase: 'thinking' }))).toBe('working')
    expect(livePhase(activity({ terminalId: 't', phase: 'waiting' }))).toBe('waiting')
  })
})

describe('ledgerPhase — history with no live signal', () => {
  it('keeps an unacknowledged last turn unread forever (no TTL)', () => {
    expect(ledgerPhase(record({ index: 1, endedAt: NOW - 90 * 24 * 3600_000 }))).toBe('unread')
  })

  it('is offline once the result was viewed', () => {
    expect(ledgerPhase(record({ index: 1, seenAt: NOW }))).toBe('offline')
  })

  it('is offline with no history at all', () => {
    expect(ledgerPhase(undefined)).toBe('offline')
  })
})

describe('mergeBoard — layer precedence', () => {
  it('prefers the live layer over probe and ledger for the same terminal', () => {
    const rows = merge({
      live: [activity({ terminalId: 't1', phase: 'thinking', turnStartedAt: NOW - 5_000 })],
      probe: new Map([['t1', 'waiting' as BoardPhase]]),
      ledger: new Map([['t1', [record({ index: 1, seenAt: NOW })]]]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].phase).toBe('working')
    expect(rows[0].source).toBe('live')
  })

  it('prefers probe over ledger for a terminal in an inactive workspace', () => {
    // The whole point of L2: a detached pane can still be shown as WORKING.
    const rows = merge({
      probe: new Map([['t1', 'working' as BoardPhase]]),
      ledger: new Map([['t1', [record({ index: 4, seenAt: NOW })]]]),
      registry: [meta({ id: 't1', workspaceId: WS_OTHER, workspaceName: 'GOAT Team' })]
    })
    expect(rows[0].phase).toBe('working')
    expect(rows[0].source).toBe('probe')
    expect(rows[0].workspace.active).toBe(false)
  })

  it('falls back to the ledger when nothing is live or probed', () => {
    const rows = merge({
      ledger: new Map([['t1', [record({ index: 2, seenAt: NOW })]]]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows[0].source).toBe('ledger')
    expect(rows[0].phase).toBe('offline')
  })

  it('never emits two rows for one terminal', () => {
    const rows = merge({
      live: [activity({ terminalId: 't1', phase: 'thinking', turnStartedAt: NOW - 1_000 })],
      probe: new Map([['t1', 'working' as BoardPhase]]),
      ledger: new Map([['t1', [record({ index: 1 })]]]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows.filter((r) => r.terminalId === 't1')).toHaveLength(1)
  })
})

describe('mergeBoard — a probe row must not invent text', () => {
  it('carries the LEDGER task text on a probe row, never a fabricated prompt', () => {
    // A detached pane has no node-pty, so nothing captured the live prompt.
    // The row shows the last KNOWN task plus a live phase dot — and says so
    // via `source`, so the UI can withhold the live tail.
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
})

describe('mergeBoard — ordering is a timeline, nothing else', () => {
  it('sorts strictly by lastActivityAt descending', () => {
    const rows = merge({
      ledger: new Map([
        ['old', [record({ index: 1, endedAt: NOW - 3 * 3600_000, seenAt: NOW })]],
        ['mid', [record({ index: 1, endedAt: NOW - 2 * 3600_000, seenAt: NOW })]],
        ['new', [record({ index: 1, endedAt: NOW - 1 * 3600_000, seenAt: NOW })]]
      ]),
      registry: [meta({ id: 'old' }), meta({ id: 'mid' }), meta({ id: 'new' })]
    })
    expect(rows.map((r) => r.terminalId)).toEqual(['new', 'mid', 'old'])
  })

  it('does NOT float a waiting row above a more recent one', () => {
    // Deliberate: floating by state turns the board back into a grouped
    // roster. Urgency is carried by styling + the aggregate counts.
    const rows = merge({
      live: [
        activity({ terminalId: 'stuck', phase: 'waiting', turnStartedAt: NOW - 3600_000 }),
        activity({ terminalId: 'fresh', phase: 'thinking', turnStartedAt: NOW - 10_000 })
      ],
      ledger: new Map([
        ['stuck', [record({ index: 1, endedAt: NOW - 3600_000 })]],
        ['fresh', [record({ index: 1, endedAt: NOW - 10_000 })]]
      ]),
      registry: [meta({ id: 'stuck' }), meta({ id: 'fresh' })]
    })
    expect(rows.map((r) => r.terminalId)).toEqual(['fresh', 'stuck'])
  })

  it('uses the live turn start as lastActivityAt for an in-flight turn', () => {
    const rows = merge({
      live: [activity({ terminalId: 't1', phase: 'thinking', turnStartedAt: NOW - 5_000 })],
      ledger: new Map([['t1', [record({ index: 1, endedAt: NOW - 3600_000 })]]]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows[0].lastActivityAt).toBe(NOW - 5_000)
    expect(rows[0].task.endedAt).toBeNull()
  })
})

describe('mergeBoard — what does NOT get a row', () => {
  it('skips an agent that never ran a turn (this is the 228→8 collapse)', () => {
    expect(merge({ registry: [meta({ id: 'never-used' })] })).toEqual([])
  })

  it('drops rows older than the window', () => {
    const rows = merge({
      ledger: new Map([
        ['recent', [record({ index: 1, endedAt: NOW - 3600_000, seenAt: NOW })]],
        ['ancient', [record({ index: 1, endedAt: NOW - 40 * 3600_000, seenAt: NOW })]]
      ]),
      registry: [meta({ id: 'recent' }), meta({ id: 'ancient' })]
    })
    expect(rows.map((r) => r.terminalId)).toEqual(['recent'])
  })

  it('keeps an in-flight turn regardless of how long it has been running', () => {
    // A 30-hour agent is exactly the one you must not lose off the board.
    const rows = merge({
      live: [activity({ terminalId: 't1', phase: 'thinking', turnStartedAt: NOW - 30 * 3600_000 })],
      ledger: new Map([['t1', [record({ index: 1, endedAt: NOW - 31 * 3600_000 })]]]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows.map((r) => r.terminalId)).toEqual(['t1'])
  })
})

describe('mergeBoard — identity', () => {
  it('emits a row for a terminal missing from the registry rather than dropping the task', () => {
    const rows = merge({
      ledger: new Map([['ghost', [record({ index: 1, prompt: 'orphaned work', seenAt: NOW })]]]),
      registry: []
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].task.summary).toBe('orphaned work')
    expect(rows[0].agent.name.length).toBeGreaterThan(0)
  })

  it('marks rows from the loaded workspace active and others not', () => {
    const rows = merge({
      ledger: new Map([
        ['here', [record({ index: 1, endedAt: NOW - 1000, seenAt: NOW })]],
        ['there', [record({ index: 1, endedAt: NOW - 2000, seenAt: NOW })]]
      ]),
      registry: [
        meta({ id: 'here' }),
        meta({ id: 'there', workspaceId: WS_OTHER, workspaceName: 'GOAT Team' })
      ]
    })
    expect(rows.find((r) => r.terminalId === 'here')?.workspace.active).toBe(true)
    expect(rows.find((r) => r.terminalId === 'there')?.workspace.active).toBe(false)
    expect(rows.find((r) => r.terminalId === 'there')?.workspace.name).toBe('GOAT Team')
  })

  it('reports the task as the LAST turn and turnCount as the full history', () => {
    const rows = merge({
      ledger: new Map([
        [
          't1',
          [
            record({ index: 1, prompt: 'first', endedAt: NOW - 7200_000 }),
            record({ index: 2, prompt: 'latest', endedAt: NOW - 60_000, seenAt: NOW })
          ]
        ]
      ]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows[0].task.summary).toBe('latest')
    expect(rows[0].task.turnIndex).toBe(2)
    expect(rows[0].turnCount).toBe(2)
  })

  it('prefers the Sous title but keeps the prompt available as the second line', () => {
    const rows = merge({
      ledger: new Map([
        ['t1', [record({ index: 1, prompt: 'a very long raw prompt', title: 'Short title', seenAt: NOW })]]
      ]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows[0].task.title).toBe('Short title')
    expect(rows[0].task.summary).toBe('a very long raw prompt')
  })
})

describe('summarizeBoard — the header strip', () => {
  it('counts phases and the preset mix', () => {
    const rows = merge({
      live: [
        activity({ terminalId: 'a', phase: 'thinking', turnStartedAt: NOW - 1_000 }),
        activity({ terminalId: 'b', phase: 'waiting', turnStartedAt: NOW - 2_000 }),
        activity({ terminalId: 'c', phase: 'replied' })
      ],
      ledger: new Map([
        ['a', [record({ index: 1, endedAt: NOW - 1_000 })]],
        ['b', [record({ index: 1, endedAt: NOW - 2_000 })]],
        ['c', [record({ index: 1, endedAt: NOW - 3_000 })]]
      ]),
      registry: [
        meta({ id: 'a' }),
        meta({ id: 'b', preset: 'Codex' }),
        meta({ id: 'c' })
      ]
    })
    const summary = summarizeBoard(rows)
    expect(summary.working).toBe(1)
    expect(summary.waiting).toBe(1)
    expect(summary.doneInWindow).toBe(1)
    expect(summary.presetMix).toEqual({ 'Claude Code': 2, Codex: 1 })
  })

  it('is all zeros on an empty board', () => {
    const summary = summarizeBoard([])
    expect(summary.working).toBe(0)
    expect(summary.waiting).toBe(0)
    expect(summary.doneInWindow).toBe(0)
    expect(summary.presetMix).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Task text hygiene. Observed on the 55" wall display: 2 of 36 rows rendered a
// raw <task-notification> block as their task title. The board must show the
// human-readable part — WITHOUT damaging a prompt that legitimately contains
// angle brackets, which is the far more common case.
// ---------------------------------------------------------------------------

describe('stripSystemWrappers — removes harness scaffolding', () => {
  it('strips the real truncated task-notification seen on the board', () => {
    const raw =
      '<task-notification>\n<task-id>bx2r4aqh6</task-id>\n' +
      '<tool-use-id>toolu_01PvpNVi12v4oP9nu5iKTZDJ</tool-use-id>\n' +
      '<output-file>/private/tmp/claude-501/tasks/bx2r4aqh6.output'
    expect(stripSystemWrappers(raw)).toBe('')
  })

  it('strips a complete task-notification block but keeps the real request', () => {
    const raw =
      '<task-notification>\n<task-id>abc</task-id>\n</task-notification>\nship the migration'
    expect(stripSystemWrappers(raw)).toBe('ship the migration')
  })

  it('strips system-reminder blocks, inline ones included', () => {
    expect(stripSystemWrappers('<system-reminder>be nice</system-reminder>\nfix the bug')).toBe(
      'fix the bug'
    )
    expect(
      stripSystemWrappers('context <system-reminder>noise</system-reminder> now do Y')
    ).toBe('context now do Y')
  })

  it('strips local-command-stdout and command-name wrappers', () => {
    expect(stripSystemWrappers('<command-name>/model</command-name>')).toBe('')
    expect(
      stripSystemWrappers('<local-command-stdout>Set model to Opus</local-command-stdout>')
    ).toBe('')
    expect(
      stripSystemWrappers('<command-name>/model</command-name>\nnow rerun the probe')
    ).toBe('now rerun the probe')
  })

  it('strips stray tool-use-id / output-file lines', () => {
    expect(stripSystemWrappers('<tool-use-id>toolu_99</tool-use-id>\nreal work here')).toBe(
      'real work here'
    )
    expect(stripSystemWrappers('<output-file>/tmp/x.output\nreal work here')).toBe(
      'real work here'
    )
  })

  it('is empty for pure noise and safe on empty input', () => {
    expect(stripSystemWrappers('')).toBe('')
    expect(stripSystemWrappers('<system-reminder>only noise</system-reminder>')).toBe('')
  })
})

describe('stripSystemWrappers — must NOT over-clean ordinary prompts', () => {
  it('leaves HTML/JSX/generics in human prose untouched', () => {
    const untouched = [
      'Use a <div> wrapper around the list',
      'In JSX, <Foo bar={1} /> renders nothing',
      'the generic List<string> should be Array<string>',
      'compare <script> and <style> tags in the head',
      'assert that a < b and b > c holds',
      'why does <MyComponent /> re-render on every keystroke?'
    ]
    for (const text of untouched) expect(stripSystemWrappers(text)).toBe(text)
  })

  it('keeps a multi-line prompt whose lines start with ordinary tags', () => {
    const raw = '<div>\n  <span>hello</span>\n</div>\nexplain this markup'
    expect(stripSystemWrappers(raw)).toBe(raw)
  })

  it('does not let an unbalanced system tag swallow following prose', () => {
    // Line-scoped stripping: the notification line goes, the request stays.
    expect(stripSystemWrappers('<task-notification>\nplease review the PR')).toBe(
      'please review the PR'
    )
  })
})

describe('taskText + mergeBoard — the prompt fallback path', () => {
  it('taskText returns the cleaned prompt of a record, and "" for none', () => {
    expect(taskText(record({ index: 1, prompt: 'plain work' }))).toBe('plain work')
    expect(taskText(record({ index: 1, prompt: '<system-reminder>x</system-reminder>' }))).toBe('')
    expect(taskText(undefined)).toBe('')
  })

  it('never renders a wrapper as the task — falls back to the last real turn', () => {
    const rows = merge({
      ledger: new Map([
        [
          't1',
          [
            record({ index: 1, prompt: 'ship the migration', endedAt: NOW - 7200_000 }),
            record({
              index: 2,
              prompt: '<task-notification>\n<task-id>bx2r4aqh6</task-id>',
              endedAt: NOW - 60_000,
              seenAt: NOW
            })
          ]
        ]
      ]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows[0].task.summary).toBe('ship the migration')
    expect(rows[0].task.turnIndex).toBe(1)
    // The row still sits at the LAST turn's position on the timeline.
    expect(rows[0].lastActivityAt).toBe(NOW - 60_000)
    expect(rows[0].turnCount).toBe(2)
  })

  it('leaves the prompt empty when every turn is noise (UI shows its fallback)', () => {
    const rows = merge({
      ledger: new Map([
        ['t1', [record({ index: 1, prompt: '<system-reminder>noise</system-reminder>', seenAt: NOW })]]
      ]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].task.summary).toBe('')
  })

  it('keeps the Sous title winning over the prompt (priority unchanged)', () => {
    const rows = merge({
      ledger: new Map([
        [
          't1',
          [record({ index: 1, prompt: 'a very long raw prompt', title: 'Short title', seenAt: NOW })]
        ]
      ]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows[0].task.title).toBe('Short title')
    expect(rows[0].task.summary).toBe('a very long raw prompt')
  })

  it('cleans a LIVE in-flight prompt too, falling back to the ledger', () => {
    const rows = merge({
      live: [
        activity({
          terminalId: 't1',
          phase: 'thinking',
          prompt: '<system-reminder>injected</system-reminder>',
          turnStartedAt: NOW - 5_000
        })
      ],
      ledger: new Map([['t1', [record({ index: 1, prompt: 'earlier real task' })]]]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows[0].task.summary).toBe('earlier real task')
  })
})

// ---------------------------------------------------------------------------
// task.summary replaced task.prompt. Every consumer only ever rendered the
// first line, so shipping the whole body (4.7 KB on one measured row) bought
// nothing and put raw task text on the wire — including onto a TV. Truncating
// at the SOURCE is what makes a second "degraded" endpoint unnecessary.
// ---------------------------------------------------------------------------

describe('taskSummary — display-ready by construction', () => {
  it('takes the first meaningful line and collapses whitespace', () => {
    expect(taskSummary('  ship   the   migration  \nsecond line\nthird')).toBe(
      'ship the migration'
    )
  })

  it('strips wrappers BEFORE picking a line, so the real request survives', () => {
    // Picking line 1 first would have yielded the notification tag.
    expect(taskSummary('<task-notification>\n<task-id>x</task-id>\nreview the PR')).toBe(
      'review the PR'
    )
  })

  it('caps at BOARD_SUMMARY_MAX with an ellipsis', () => {
    const summary = taskSummary('Z'.repeat(4783))
    expect(summary.length).toBe(BOARD_SUMMARY_MAX)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('is empty for pure noise and empty input', () => {
    expect(taskSummary('')).toBe('')
    expect(taskSummary('<system-reminder>noise</system-reminder>')).toBe('')
  })
})

describe('mergeBoard — no raw task text ever leaves the merge', () => {
  it('never emits a summary longer than the cap, however long the prompt', () => {
    const huge = `${'Q'.repeat(4783)}\nsecond line`
    const rows = merge({
      ledger: new Map([['t1', [record({ index: 1, prompt: huge, seenAt: NOW })]]]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows[0].task.summary.length).toBeLessThanOrEqual(BOARD_SUMMARY_MAX)
    expect(JSON.stringify(rows)).not.toContain('Q'.repeat(BOARD_SUMMARY_MAX + 1))
  })

  it('never emits a summary containing system wrapper markup', () => {
    const rows = merge({
      ledger: new Map([
        [
          't1',
          [
            record({
              index: 1,
              prompt: '<task-notification>\n<tool-use-id>toolu_01</tool-use-id>\nrun the probe',
              seenAt: NOW
            })
          ]
        ]
      ]),
      registry: [meta({ id: 't1' })]
    })
    expect(rows[0].task.summary).toBe('run the probe')
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('task-notification')
    expect(serialized).not.toContain('toolu_01')
  })

  it('carries no `prompt` key at all — the field is gone, not just trimmed', () => {
    const rows = merge({
      ledger: new Map([['t1', [record({ index: 1, prompt: 'anything', seenAt: NOW })]]]),
      registry: [meta({ id: 't1' })]
    })
    expect(Object.keys(rows[0].task).sort()).toEqual([
      'endedAt',
      'startedAt',
      'summary',
      'title',
      'turnIndex'
    ])
  })
})
