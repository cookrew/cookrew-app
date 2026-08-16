// Harness-session turn derivation: pi + codex session files must yield the
// SAME TurnRecord history Claude gets (the "endpoint history" the rail and
// card pager render), with indices aligned 1:1 with the trace blocks the
// checkpoint rail reads — one identity space, by construction.

import { describe, expect, it } from 'vitest'
import { parseCodexTrace, parseCodexTurns, parsePiTrace, parsePiTurns } from '../src/shared/trace-blocks'

const T0 = Date.parse('2026-08-05T10:00:00.000Z')

function piMessage(
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  ms: number,
  stopReason?: string
): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId,
    message: { role, content, timestamp: ms, ...(stopReason !== undefined ? { stopReason } : {}) }
  })
}

// A pi session tree: two turns on the ACTIVE branch, plus an abandoned
// sibling branch (a /tree fork that was not taken) that must NOT leak in.
const PI_LINES = [
  JSON.stringify({ type: 'session', id: 'sess-1', cwd: '/work/repo' }),
  piMessage('u1', null, 'user', 'first prompt', T0),
  piMessage('a1', 'u1', 'assistant', [{ type: 'text', text: 'reply one' }], T0 + 1000),
  // Abandoned branch off a1:
  piMessage('x1', 'a1', 'user', 'abandoned direction', T0 + 2000),
  piMessage('xa', 'x1', 'assistant', [{ type: 'text', text: 'abandoned reply' }], T0 + 3000),
  // Active branch continues from a1:
  piMessage('u2', 'a1', 'user', 'second prompt', T0 + 4000),
  piMessage('a2', 'u2', 'assistant', [{ type: 'text', text: 'reply two' }], T0 + 5000)
]

describe('parsePiTurns', () => {
  it('derives one TurnRecord per user prompt on the active branch', () => {
    const turns = parsePiTurns(PI_LINES)
    expect(turns.map((t) => t.prompt)).toEqual(['first prompt', 'second prompt'])
    expect(turns.map((t) => t.reply)).toEqual(['reply one', 'reply two'])
  })

  it('stamps index, uuid and timestamps from the session entries', () => {
    const turns = parsePiTurns(PI_LINES)
    expect(turns.map((t) => t.index)).toEqual([1, 2])
    expect(turns.map((t) => t.uuid)).toEqual(['u1', 'u2'])
    expect(turns[0].startedAt).toBe(T0)
    expect(turns[0].endedAt).toBe(T0 + 1000)
    expect(turns[1].endedAt).toBe(T0 + 5000)
  })

  it('keeps turn indices identical to the checkpoint rail trace blocks', () => {
    const blocks = parsePiTrace(PI_LINES)
    const turns = parsePiTurns(PI_LINES)
    expect(turns.map((t) => t.index)).toEqual(blocks.map((b) => b.index))
    expect(turns.map((t) => t.uuid)).toEqual(blocks.map((b) => b.id))
  })
})

// Sol round-2 P0: a file-backed dispatch on pi must be CLOSABLE from the
// file. Every non-tail record is final (a later user prompt is positive
// end-of-turn evidence); the tail is final exactly when pi's own marker —
// the latest assistant message's stopReason 'stop', verified on real
// ~/.cookrew/pi-sessions files — says the turn completed.
describe('parsePiTurns finality', () => {
  it('non-tail records are final by the next-user boundary', () => {
    const turns = parsePiTurns(PI_LINES)
    expect(turns.map((t) => t.final)).toEqual([true, undefined])
  })

  it("the tail is final when its last assistant message stopped with 'stop'", () => {
    const turns = parsePiTurns([
      piMessage('u1', null, 'user', 'do it', T0),
      piMessage('a1', 'u1', 'assistant', [{ type: 'text', text: 'done' }], T0 + 1000, 'stop')
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].final).toBe(true)
  })

  it("a tail mid-tool-use ('toolUse') stays open", () => {
    const turns = parsePiTurns([
      piMessage('u1', null, 'user', 'do it', T0),
      piMessage('a1', 'u1', 'assistant', [{ type: 'text', text: 'working…' }], T0 + 1000, 'toolUse')
    ])
    expect(turns[0].final).toBeUndefined()
  })

  it('finality tracks the LATEST assistant message — a follow-up reopens the turn', () => {
    const turns = parsePiTurns([
      piMessage('u1', null, 'user', 'do it', T0),
      piMessage('a1', 'u1', 'assistant', [{ type: 'text', text: 'done' }], T0 + 1000, 'stop'),
      piMessage('a2', 'a1', 'assistant', [{ type: 'text', text: 'more' }], T0 + 2000, 'toolUse')
    ])
    expect(turns[0].final).toBeUndefined()
  })

  it("an aborted or errored tail is NOT completion evidence", () => {
    for (const stopReason of ['aborted', 'error', 'length']) {
      const turns = parsePiTurns([
        piMessage('u1', null, 'user', 'do it', T0),
        piMessage('a1', 'u1', 'assistant', [{ type: 'text', text: 'partial' }], T0 + 1000, stopReason)
      ])
      expect(turns[0].final, stopReason).toBeUndefined()
    }
  })
})

function codexLine(ms: number, type: string, payload: unknown): string {
  return JSON.stringify({ timestamp: new Date(ms).toISOString(), type, payload })
}

const CODEX_LINES = [
  codexLine(T0, 'session_meta', { session_id: 's1', timestamp: new Date(T0).toISOString(), cwd: '/work/repo' }),
  codexLine(T0 + 1000, 'event_msg', { type: 'user_message', message: 'codex prompt one' }),
  codexLine(T0 + 1500, 'event_msg', { type: 'agent_message', message: 'codex reply one', phase: 'final_answer' }),
  codexLine(T0 + 2000, 'event_msg', { type: 'user_message', message: 'codex prompt two' }),
  codexLine(T0 + 2500, 'event_msg', { type: 'agent_message', message: 'codex reply two', phase: 'final_answer' })
]

describe('parseCodexTurns', () => {
  it('derives TurnRecords from rollout event messages', () => {
    const turns = parseCodexTurns(CODEX_LINES)
    expect(turns.map((t) => t.prompt)).toEqual(['codex prompt one', 'codex prompt two'])
    expect(turns.map((t) => t.reply)).toEqual(['codex reply one', 'codex reply two'])
    expect(turns.map((t) => t.index)).toEqual([1, 2])
  })

  it('keeps turn indices identical to the checkpoint rail trace blocks', () => {
    const blocks = parseCodexTrace(CODEX_LINES)
    const turns = parseCodexTurns(CODEX_LINES)
    expect(turns.map((t) => t.index)).toEqual(blocks.map((b) => b.index))
  })

  // Sol round-2 P0: codex finality. `task_complete` is the rollout's own
  // per-turn end marker (verified on real ~/.codex/sessions files, both
  // rollout generations; an interrupted turn writes `turn_aborted` and no
  // task_complete). Non-tail records are final by the next-user boundary.
  it('non-tail records are final by the next-user boundary; a bare tail stays open', () => {
    const turns = parseCodexTurns(CODEX_LINES)
    expect(turns.map((t) => t.final)).toEqual([true, undefined])
  })

  it('task_complete closes the tail — the file alone can settle a background dispatch', () => {
    const turns = parseCodexTurns([
      ...CODEX_LINES,
      codexLine(T0 + 3000, 'event_msg', {
        type: 'task_complete',
        turn_id: 't2',
        last_agent_message: 'codex reply two'
      })
    ])
    expect(turns.map((t) => t.final)).toEqual([true, true])
  })

  it('an interrupted turn (turn_aborted, no task_complete) stays open until the next prompt', () => {
    const turns = parseCodexTurns([
      ...CODEX_LINES,
      codexLine(T0 + 3000, 'event_msg', { type: 'turn_aborted', turn_id: 't2' })
    ])
    expect(turns[1].final).toBeUndefined()
  })

  it('reads the NEW rollout generation (item_completed) with task_complete finality', () => {
    // Shapes verified verbatim against a codex-cli 0.147 rollout: the old
    // user_message/agent_message events are gone; prompts and replies arrive
    // as completed items (AgentMessage text blocks use a capital-T 'Text').
    const lines = [
      codexLine(T0, 'session_meta', { session_id: 's9', timestamp: new Date(T0).toISOString(), cwd: '/w' }),
      codexLine(T0 + 500, 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      codexLine(T0 + 1000, 'event_msg', {
        type: 'item_completed',
        turn_id: 'turn-1',
        item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'hi', text_elements: [] }] }
      }),
      codexLine(T0 + 2000, 'event_msg', {
        type: 'item_completed',
        turn_id: 'turn-1',
        item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'Hi. What are we working on?' }], phase: 'final_answer' }
      }),
      codexLine(T0 + 2500, 'event_msg', { type: 'token_count' }),
      codexLine(T0 + 3000, 'event_msg', {
        type: 'task_complete',
        turn_id: 'turn-1',
        last_agent_message: 'Hi. What are we working on?'
      })
    ]
    const turns = parseCodexTurns(lines)
    expect(turns).toHaveLength(1)
    expect(turns[0].prompt).toBe('hi')
    expect(turns[0].reply).toBe('Hi. What are we working on?')
    expect(turns[0].uuid).toBe('s9:p1')
    expect(turns[0].final).toBe(true)
    // Identity space still matches the trace blocks.
    expect(parseCodexTrace(lines).map((b) => b.index)).toEqual([1])
  })

  it('task_complete carries the reply when no reply event landed at all', () => {
    const lines = [
      codexLine(T0, 'session_meta', { session_id: 's9', timestamp: new Date(T0).toISOString(), cwd: '/w' }),
      codexLine(T0 + 1000, 'event_msg', {
        type: 'item_completed',
        turn_id: 'turn-1',
        item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'ship it' }] }
      }),
      codexLine(T0 + 3000, 'event_msg', {
        type: 'task_complete',
        turn_id: 'turn-1',
        last_agent_message: 'Shipped.'
      })
    ]
    const turns = parseCodexTurns(lines)
    expect(turns[0].reply).toBe('Shipped.')
    expect(turns[0].final).toBe(true)
  })

  it('transitional rollouts (item_completed only for Plan items) cannot double-open a block', () => {
    // Observed in the real corpus: builds that emit BOTH user_message events
    // and item_completed records use the latter only for Plan items.
    const lines = [
      CODEX_LINES[0],
      CODEX_LINES[1],
      codexLine(T0 + 1200, 'event_msg', {
        type: 'item_completed',
        item: { type: 'Plan', content: [{ type: 'text', text: 'step 1' }] }
      }),
      CODEX_LINES[2]
    ]
    const turns = parseCodexTurns(lines)
    expect(turns).toHaveLength(1)
    expect(turns[0].prompt).toBe('codex prompt one')
  })

  it('namespaces turn uuids with the rollout session id (no cross-session title collision)', () => {
    const other = CODEX_LINES.map((line, i) =>
      i === 0
        ? codexLine(T0, 'session_meta', { session_id: 's2', timestamp: new Date(T0).toISOString(), cwd: '/work/repo' })
        : line
    )
    const a = parseCodexTurns(CODEX_LINES)
    const b = parseCodexTurns(other)
    expect(a[0].uuid).toBe('s1:p1')
    expect(b[0].uuid).toBe('s2:p1')
    // Same ordinal in a DIFFERENT session must never share a uuid — the
    // TurnTracker title carryover keys on exact uuid equality.
    expect(a.map((t) => t.uuid)).not.toEqual(b.map((t) => t.uuid))
  })
})
