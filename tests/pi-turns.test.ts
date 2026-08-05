// Harness-session turn derivation: pi + codex session files must yield the
// SAME TurnRecord history Claude gets (the "endpoint history" the rail and
// card pager render), with indices aligned 1:1 with the trace blocks the
// checkpoint rail reads — one identity space, by construction.

import { describe, expect, it } from 'vitest'
import { parseCodexTrace, parseCodexTurns, parsePiTrace, parsePiTurns } from '../src/shared/trace-blocks'

const T0 = Date.parse('2026-08-05T10:00:00.000Z')

function piMessage(id: string, parentId: string | null, role: string, content: unknown, ms: number): string {
  return JSON.stringify({ type: 'message', id, parentId, message: { role, content, timestamp: ms } })
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
