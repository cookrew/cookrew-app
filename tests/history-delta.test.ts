// Sol r4 P1: incremental byte reads were not I3 — every append still handed
// downstream the COMPLETE history to re-project. The accumulators now emit
// DELTAS: takeDelta() describes what changed since the last take as a
// strictly-new 'append', an in-place 'tail' rewrite, or a 'reset' that
// invalidates prior emissions (a Pi branch switch). A take is a
// PARTIAL-ADVANCE cursor — a combined change drains as 'tail' then 'append'
// — so the contract under test is the replay property: DRAINING every take
// in order per the apply contract documented on HistoryDelta reconstructs
// records() exactly, for ANY chunking of the input, for all three
// harnesses. The O(delta) gate rides alongside: one appended turn on a
// 300-turn history must emit one record, never three hundred.

import { describe, expect, it } from 'vitest'
import {
  parseSessionTurns,
  type HistoryDelta,
  type StreamingTurnParser
} from '../src/shared/session-turns'
import { parseCodexTurns, parsePiTurns } from '../src/shared/trace-blocks'
import type { TurnRecord } from '../src/shared/turn'

const T0 = Date.parse('2026-08-05T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

// ---- the apply contract (what TurnTracker.applyHistoryDelta implements) ----

function applyDelta(
  history: TurnRecord[],
  delta: HistoryDelta,
  full: () => TurnRecord[]
): TurnRecord[] {
  if (delta.kind === 'reset') return full()
  if (delta.kind === 'tail') {
    const last = history[history.length - 1]
    expect(last, 'tail rewrite over an empty history').toBeDefined()
    expect(delta.record.index, 'tail rewrite must keep its slot').toBe(last.index)
    return [...history.slice(0, -1), delta.record]
  }
  if (delta.records.length === 0) return history
  // Strictly new and index-contiguous: an append lands exactly after the
  // history — a record is never emitted twice (the consumer's boundary
  // dedupe must not be asked to swallow same-uuid duplicates).
  expect(delta.records[0].index, 'append must be index-contiguous').toBe(history.length + 1)
  delta.records.forEach((record, at) => expect(record.index).toBe(history.length + at + 1))
  return [...history, ...delta.records]
}

/** Take-until-caught-up, applying each delta: the drain SessionTurnSync
 *  runs (a 'tail' take advances only the tail cursor; the next take brings
 *  whatever queued behind it — bounded at two takes per drain). */
function drain(
  accumulator: { takeDelta?: () => HistoryDelta; records: () => TurnRecord[] },
  history: TurnRecord[]
): TurnRecord[] {
  let next = history
  for (let takes = 0; ; takes += 1) {
    expect(takes, 'a drain must be bounded').toBeLessThan(3)
    const delta = accumulator.takeDelta?.() as HistoryDelta
    next = applyDelta(next, delta, () => accumulator.records())
    if (delta.kind !== 'tail') return next
  }
}

// ---- per-harness fixtures: N marker-closed turns + one appendable turn ----

function claudeUser(n: number, at: number, text: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: `u-${n}`,
    parentUuid: `p-${n}`,
    message: { role: 'user', content: text },
    timestamp: iso(at)
  })
}

function claudeAssistant(at: number, text: string, stopReason: string | null): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stopReason },
    timestamp: iso(at)
  })
}

/** One closed Claude turn (end_turn marker) — the O(delta) unit. */
function claudeTurn(n: number): string[] {
  const at = T0 + n * 60_000
  return [claudeUser(n, at, `prompt ${n} — été 目标`), claudeAssistant(at + 5000, `done ${n} ✓`, 'end_turn')]
}

/** A realistic Claude session: closed turns, a sibling resend, junk, and an
 *  OPEN tail (tool_use, no end_turn) so the boundary/append overlap is hit. */
function claudeLines(): string[] {
  const lines: string[] = []
  for (let n = 0; n < 8; n += 1) {
    const at = T0 + n * 60_000
    lines.push(claudeUser(n, at, `prompt ${n} — été 目标`))
    if (n === 2) {
      // Sibling resend (same parentUuid) — collapses, rewriting the tail.
      lines.push(claudeUser(n, at + 1000, `prompt ${n} refined`))
    }
    lines.push(claudeAssistant(at + 3000, `working ${n}…`, 'tool_use'))
    if (n % 3 === 0) lines.push('this line is not json')
    lines.push(claudeAssistant(at + 5000, `done ${n} ✓`, n === 7 ? 'tool_use' : 'end_turn'))
  }
  return lines
}

function codexLine(ms: number, type: string, payload: unknown): string {
  return JSON.stringify({ timestamp: iso(ms), type, payload })
}

/** One closed Codex turn (task_complete marker). */
function codexTurn(n: number): string[] {
  const at = T0 + n * 60_000
  return [
    codexLine(at, 'event_msg', { type: 'user_message', message: `prompt ${n}` }),
    codexLine(at + 4000, 'event_msg', { type: 'agent_message', message: `reply ${n} ✓` }),
    codexLine(at + 5000, 'event_msg', {
      type: 'task_complete', turn_id: `t${n}`, last_agent_message: `reply ${n} ✓`
    })
  ]
}

/** A realistic rollout: tools, junk, an aborted turn, an OPEN tail. */
function codexLines(): string[] {
  const lines: string[] = [
    codexLine(T0, 'session_meta', { session_id: 's1', timestamp: iso(T0), cwd: '/w' })
  ]
  for (let n = 0; n < 8; n += 1) {
    const at = T0 + n * 60_000
    lines.push(codexLine(at, 'event_msg', { type: 'user_message', message: `prompt ${n} — été` }))
    lines.push(
      codexLine(at + 1000, 'response_item', {
        type: 'custom_tool_call', name: 'shell', input: `ls ${n}`, call_id: `c${n}`
      })
    )
    if (n % 3 === 0) lines.push('not json at all')
    lines.push(
      codexLine(at + 2000, 'response_item', {
        type: 'custom_tool_call_output', call_id: `c${n}`, output: `out ${n}`
      })
    )
    lines.push(codexLine(at + 4000, 'event_msg', { type: 'agent_message', message: `reply ${n} ✓` }))
    if (n === 5) {
      lines.push(codexLine(at + 5000, 'event_msg', { type: 'turn_aborted', turn_id: `t${n}` }))
    } else if (n !== 7) {
      // Turn 7 stays OPEN — no closing marker — so the next-user boundary
      // path is exercised when anything appends after the whole fixture.
      lines.push(
        codexLine(at + 5000, 'event_msg', {
          type: 'task_complete', turn_id: `t${n}`, last_agent_message: `reply ${n} ✓`
        })
      )
    }
  }
  return lines
}

function piMessage(
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  ms: number,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type: 'message', id, parentId,
    message: { role, content, timestamp: ms, ...extra }
  })
}

/** One closed Pi turn (stopReason 'stop'). */
function piTurn(n: number, parent: string | null): string[] {
  const at = T0 + n * 60_000
  return [
    piMessage(`u${n}`, parent, 'user', `prompt ${n}`, at),
    piMessage(`a${n}`, `u${n}`, 'assistant', [{ type: 'text', text: `reply ${n}` }], at + 3000, {
      stopReason: 'stop'
    })
  ]
}

/** A realistic pi tree: tools, an aborted turn, junk, an OPEN toolUse tail. */
function piLines(): string[] {
  const lines: string[] = [JSON.stringify({ type: 'session', id: 'sess', cwd: '/w' })]
  let parent: string | null = null
  for (let n = 0; n < 6; n += 1) {
    const at = T0 + n * 60_000
    lines.push(piMessage(`u${n}`, parent, 'user', `prompt ${n} — naïve 完成`, at))
    lines.push(
      piMessage(`t${n}`, `u${n}`, 'assistant', [
        { type: 'text', text: `thinking ${n}` },
        { type: 'toolCall', id: `call${n}`, name: 'bash', arguments: { command: `ls ${n}` } }
      ], at + 1000, { stopReason: 'toolUse' })
    )
    if (n % 2 === 0) lines.push('{broken json')
    lines.push(
      piMessage(`r${n}`, `t${n}`, 'toolResult', `out ${n}`, at + 2000, { toolCallId: `call${n}` })
    )
    if (n !== 5) {
      // Turn 5's tail stays OPEN on the toolUse above.
      lines.push(
        piMessage(`a${n}`, `r${n}`, 'assistant', [{ type: 'text', text: `reply ${n}` }], at + 3000, {
          stopReason: n === 3 ? 'aborted' : 'stop'
        })
      )
    }
    parent = n === 5 ? `r${n}` : `a${n}`
  }
  return lines
}

/** Deterministic LCG so a failing trial is reproducible from its seed. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function chunked<T>(items: T[], rand: () => number): T[][] {
  const chunks: T[][] = []
  let at = 0
  while (at < items.length) {
    const size = 1 + Math.floor(rand() * 5)
    chunks.push(items.slice(at, at + size))
    at += size
  }
  return chunks
}

interface HarnessCase {
  id: string
  parse: StreamingTurnParser
  lines: () => string[]
  /** N marker-closed turns as one line array (the O(delta) base). */
  closedTurns: (count: number) => string[]
  /** The single turn appended after `closedTurns(count)`. */
  oneMore: (count: number) => string[]
}

const CASES: HarnessCase[] = [
  {
    id: 'claude',
    parse: parseSessionTurns,
    lines: claudeLines,
    closedTurns: (count) => Array.from({ length: count }, (_, n) => claudeTurn(n)).flat(),
    oneMore: (count) => claudeTurn(count)
  },
  {
    id: 'codex',
    parse: parseCodexTurns,
    lines: codexLines,
    closedTurns: (count) => [
      codexLine(T0 - 1000, 'session_meta', { session_id: 's1', timestamp: iso(T0 - 1000), cwd: '/w' }),
      ...Array.from({ length: count }, (_, n) => codexTurn(n)).flat()
    ],
    oneMore: (count) => codexTurn(count)
  },
  {
    id: 'pi',
    parse: parsePiTurns,
    lines: piLines,
    closedTurns: (count) =>
      Array.from({ length: count }, (_, n) => piTurn(n, n === 0 ? null : `a${n - 1}`)).flat(),
    oneMore: (count) => piTurn(count, `a${count - 1}`)
  }
]

for (const { id, parse, lines, closedTurns, oneMore } of CASES) {
  describe(`${id} takeDelta — replay reconstruction`, () => {
    it('draining every take equals records() at THAT point, across randomized chunk splits (30 seeded trials)', () => {
      const all = lines()
      const whole = parse(all)
      expect(whole.length).toBeGreaterThan(3)
      for (let seed = 1; seed <= 30; seed += 1) {
        const rand = lcg(seed)
        const accumulator = parse.createAccumulator()
        expect(accumulator.takeDelta, 'harness accumulators must emit deltas').toBeDefined()
        let replayed: TurnRecord[] = []
        for (const chunk of chunked(all, rand)) {
          accumulator.feed(chunk)
          // Drain at a random subset of feed points — takes must compose
          // regardless of how many feeds each drain spans.
          if (rand() < 0.6) {
            replayed = drain(accumulator, replayed)
            expect(replayed, `seed ${seed} (mid-stream)`).toEqual(accumulator.records())
          }
        }
        replayed = drain(accumulator, replayed)
        expect(replayed, `seed ${seed}`).toEqual(whole)
      }
    })

    it('one appended turn after a 300-turn history emits a ONE-record append — the O(delta) gate', () => {
      const accumulator = parse.createAccumulator()
      accumulator.feed(closedTurns(300))
      // Consume the backlog: the first take carries everything, once.
      const initial = accumulator.takeDelta?.() as HistoryDelta
      expect(initial.kind).toBe('append')
      expect(initial.kind === 'append' && initial.records).toHaveLength(300)

      accumulator.feed(oneMore(300))
      const delta = accumulator.takeDelta?.() as HistoryDelta
      expect(delta.kind).toBe('append')
      if (delta.kind === 'append') {
        // The prior tail was marker-closed when emitted, so nothing about it
        // changed — the delta is the appended turn ALONE, not the history.
        expect(delta.records).toHaveLength(1)
        expect(delta.records[0].index).toBe(301)
      }
    })

    it('a take with nothing new is an empty append', () => {
      const accumulator = parse.createAccumulator()
      accumulator.feed(closedTurns(3))
      accumulator.takeDelta?.()
      expect(accumulator.takeDelta?.()).toEqual({ kind: 'append', records: [] })
    })
  })
}

// ---- kind semantics, pinned per transition ----

describe('takeDelta kinds (Sol r4 P1)', () => {
  it('an emitted open tail growing arrives as a tail rewrite, not a replay', () => {
    const accumulator = parseSessionTurns.createAccumulator()
    accumulator.feed([claudeUser(1, T0, 'do it')])
    accumulator.takeDelta?.()
    accumulator.feed([claudeAssistant(T0 + 2000, 'working…', 'tool_use')])
    const delta = accumulator.takeDelta?.() as HistoryDelta
    expect(delta.kind).toBe('tail')
    expect(delta.kind === 'tail' && delta.record).toMatchObject({ index: 1, reply: 'working…' })
  })

  it('finality landing on an emitted tail with nothing behind it is a tail rewrite carrying the verdict', () => {
    const accumulator = parseCodexTurns.createAccumulator()
    accumulator.feed([
      codexLine(T0, 'session_meta', { session_id: 's', timestamp: iso(T0), cwd: '/w' }),
      codexLine(T0 + 1000, 'event_msg', { type: 'user_message', message: 'do it' }),
      codexLine(T0 + 2000, 'event_msg', { type: 'agent_message', message: 'partial' })
    ])
    accumulator.takeDelta?.()
    accumulator.feed([codexLine(T0 + 3000, 'event_msg', { type: 'turn_aborted' })])
    const delta = accumulator.takeDelta?.() as HistoryDelta
    expect(delta.kind).toBe('tail')
    expect(delta.kind === 'tail' && delta.record).toMatchObject({
      index: 1,
      final: true,
      outcome: 'interrupted'
    })
  })

  it('the next-user boundary drains as the finalized tail rewrite, THEN the append of the next prompt', () => {
    const accumulator = parseSessionTurns.createAccumulator()
    // Turn 1 has no end_turn marker — only the next prompt can close it.
    accumulator.feed([claudeUser(1, T0, 'first'), claudeAssistant(T0 + 2000, 'partial', null)])
    accumulator.takeDelta?.()
    accumulator.feed(claudeTurn(2))
    // Take 1: the emitted open tail's finalization, alone — the consumer's
    // history still ends at record 1, exactly the shape a tail rewrite fits.
    const first = accumulator.takeDelta?.() as HistoryDelta
    expect(first.kind).toBe('tail')
    expect(first.kind === 'tail' && first.record).toMatchObject({ index: 1, final: true })
    // Take 2: the strictly-new records behind it. Nothing emitted twice.
    const second = accumulator.takeDelta?.() as HistoryDelta
    expect(second.kind).toBe('append')
    expect(second.kind === 'append' && second.records.map((r) => r.index)).toEqual([2])
  })

  it('a Pi branch switch invalidates prior emissions with reset', () => {
    const accumulator = parsePiTurns.createAccumulator()
    accumulator.feed([...piTurn(1, null), ...piTurn(2, 'a1'), ...piTurn(3, 'a2')].flat())
    accumulator.takeDelta?.()
    // /tree back to turn 1 and continue: the new prompt's parent is an OLDER
    // node, re-rooting the visible conversation — nothing emitted survives.
    accumulator.feed([
      piMessage('u-branch', 'a1', 'user', 'other path', T0 + 99_000),
      piMessage('a-branch', 'u-branch', 'assistant', [{ type: 'text', text: 'taken' }], T0 + 99_500, {
        stopReason: 'stop'
      })
    ])
    expect(accumulator.takeDelta?.()).toEqual({ kind: 'reset' })
    // The reset consumer re-projects from records(): exact, and the takes
    // that follow are back on the cheap path.
    expect(accumulator.records().map((r) => r.uuid)).toEqual(['u1', 'u-branch'])
    expect(accumulator.takeDelta?.()).toEqual({ kind: 'append', records: [] })
  })

  it('the first take carries the whole backlog as one append', () => {
    const accumulator = parsePiTurns.createAccumulator()
    accumulator.feed([...piTurn(1, null), ...piTurn(2, 'a1')].flat())
    const delta = accumulator.takeDelta?.() as HistoryDelta
    expect(delta.kind).toBe('append')
    expect(delta.kind === 'append' && delta.records.map((r) => r.index)).toEqual([1, 2])
  })
})
