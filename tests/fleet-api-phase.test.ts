import { describe, expect, it } from 'vitest'
import { mergeBoard, type BoardPhase, type BoardSource } from '../src/shared/board'
import type { TerminalActivity, TurnPhase, TurnRecord } from '../src/shared/turn'
import { agentPhaseOf, phaseSourceOf, phaseVerdict, verdictOfRow } from '../src/main/fleet/phase'

const NOW = 1_800_000_000_000

const activity = (terminalId: string, phase: TurnPhase, extra: Partial<TerminalActivity> = {}): TerminalActivity => ({
  terminalId,
  agent: true,
  phase,
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
  turnStartedAt: NOW - 1000,
  dispatchId: null,
  updatedAt: NOW,
  ...extra
})

const record = (index: number, seen: boolean): TurnRecord => ({
  index,
  prompt: `Invented task ${index}`,
  reply: 'ok',
  startedAt: NOW - 10_000 * (10 - index),
  endedAt: NOW - 10_000 * (10 - index) + 5000,
  ...(seen ? { seenAt: NOW } : {})
})

describe('phase mapping', () => {
  it('maps every board phase exactly', () => {
    const table: Array<[BoardPhase, string]> = [
      ['working', 'thinking'],
      ['waiting', 'waiting'],
      ['unread', 'replied'],
      ['done', 'idle'],
      ['offline', 'offline']
    ]
    for (const [board, agent] of table) expect(agentPhaseOf(board)).toBe(agent)
  })

  it('passes the source through unchanged', () => {
    for (const source of ['live', 'probe', 'ledger'] as BoardSource[]) expect(phaseSourceOf(source)).toBe(source)
  })

  it('never upgrades a probe to live', () => {
    expect(phaseVerdict(undefined, 'working', [record(1, true)])).toEqual({ phase: 'thinking', source: 'probe' })
    expect(phaseVerdict(undefined, 'waiting', [])).toEqual({ phase: 'waiting', source: 'probe' })
  })

  it('gives an agent with no signal at all an offline ledger verdict', () => {
    expect(phaseVerdict(undefined, undefined, undefined)).toEqual({ phase: 'offline', source: 'ledger' })
    expect(phaseVerdict(undefined, undefined, [record(1, false)])).toEqual({ phase: 'replied', source: 'ledger' })
  })

  it('agrees with every row the board itself produces', () => {
    const phases: TurnPhase[] = ['idle', 'thinking', 'waiting', 'replied']
    const probes: Array<BoardPhase | undefined> = [undefined, 'working', 'waiting']
    let checked = 0
    for (const live of [undefined, ...phases]) {
      for (const probe of probes) {
        for (const history of [[], [record(1, true)], [record(1, true), record(2, false)]]) {
          const id = 't'
          const act = live ? activity(id, live) : undefined
          const rows = mergeBoard({
            live: act ? [act] : [],
            probe: probe ? new Map([[id, probe]]) : new Map(),
            ledger: new Map([[id, history]]),
            registry: [],
            activeWorkspaceId: 'w',
            now: NOW,
            windowMs: Number.POSITIVE_INFINITY
          })
          if (rows.length === 0) continue
          expect(phaseVerdict(act, probe, history)).toEqual(verdictOfRow(rows[0]))
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(20)
  })
})
