import { describe, expect, it } from 'vitest'
import {
  buildForkedSessionLinesAtTurn,
  buildForkedSessionLinesAtUuid
} from '../src/shared/claude-fork'

function user(content: unknown, ts: string, uuid?: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    timestamp: ts,
    sessionId: 'src-session',
    ...(uuid ? { uuid } : {})
  })
}

function assistant(textContent: string, ts: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: textContent }] },
    timestamp: ts,
    sessionId: 'src-session'
  })
}

const LINES = [
  user('turn one', '2026-07-20T10:00:00Z'),
  assistant('reply one', '2026-07-20T10:00:10Z'),
  user('<command-name>/clear</command-name>', '2026-07-20T10:00:20Z'),
  user('turn two', '2026-07-20T10:01:00Z'),
  assistant('reply two', '2026-07-20T10:01:10Z'),
  user('turn three', '2026-07-20T10:02:00Z'),
  assistant('reply three', '2026-07-20T10:02:10Z')
]

describe('buildForkedSessionLinesAtTurn', () => {
  it('keeps exactly the first N real turns — cut lands before prompt N+1', () => {
    const kept = buildForkedSessionLinesAtTurn(LINES, { newSessionId: 'fork', keepPrompts: 2 })
    const prompts = kept
      .map((l) => JSON.parse(l) as { message?: { content?: unknown } })
      .map((r) => r.message?.content)
      .filter((c): c is string => typeof c === 'string')
    expect(prompts).toContain('turn one')
    expect(prompts).toContain('turn two')
    expect(prompts).not.toContain('turn three')
    expect(kept.some((l) => l.includes('reply two'))).toBe(true)
    expect(kept.some((l) => l.includes('reply three'))).toBe(false)
  })

  it('does not count command-noise user records as turns', () => {
    const kept = buildForkedSessionLinesAtTurn(LINES, { newSessionId: 'fork', keepPrompts: 1 })
    expect(kept.some((l) => l.includes('turn one'))).toBe(true)
    expect(kept.some((l) => l.includes('turn two'))).toBe(false)
  })

  it('restamps every kept record with the fork session id', () => {
    const kept = buildForkedSessionLinesAtTurn(LINES, { newSessionId: 'fork-id', keepPrompts: 2 })
    const ids = kept.map((l) => (JSON.parse(l) as { sessionId?: string }).sessionId)
    expect(ids.every((id) => id === 'fork-id')).toBe(true)
  })

  it('keeps the whole session when forking from the latest turn', () => {
    const kept = buildForkedSessionLinesAtTurn(LINES, { newSessionId: 'fork', keepPrompts: 3 })
    expect(kept).toHaveLength(LINES.length)
  })
})

const UUID_LINES = [
  user('turn one', '2026-07-20T10:00:00Z', 'uuid-1'),
  assistant('reply one', '2026-07-20T10:00:10Z'),
  user('<command-name>/clear</command-name>', '2026-07-20T10:00:20Z', 'uuid-noise'),
  user('turn two', '2026-07-20T10:01:00Z', 'uuid-2'),
  assistant('reply two', '2026-07-20T10:01:10Z'),
  user('turn three', '2026-07-20T10:02:00Z', 'uuid-3'),
  assistant('reply three', '2026-07-20T10:02:10Z')
]

describe('buildForkedSessionLinesAtUuid', () => {
  it('keeps the cutoff turn and everything prior, breaking at the next real prompt', () => {
    const kept = buildForkedSessionLinesAtUuid(UUID_LINES, {
      newSessionId: 'fork',
      cutoffUuid: 'uuid-2'
    })
    expect(kept.some((l) => l.includes('turn one'))).toBe(true)
    expect(kept.some((l) => l.includes('turn two'))).toBe(true)
    expect(kept.some((l) => l.includes('reply two'))).toBe(true)
    expect(kept.some((l) => l.includes('turn three'))).toBe(false)
    expect(kept.some((l) => l.includes('reply three'))).toBe(false)
  })

  it('keeps the whole session when the cutoff is the latest turn', () => {
    const kept = buildForkedSessionLinesAtUuid(UUID_LINES, {
      newSessionId: 'fork',
      cutoffUuid: 'uuid-3'
    })
    expect(kept).toHaveLength(UUID_LINES.length)
  })

  it('keeps the whole session when the cutoff uuid is not found (safe fallback)', () => {
    const kept = buildForkedSessionLinesAtUuid(UUID_LINES, {
      newSessionId: 'fork',
      cutoffUuid: 'nope'
    })
    expect(kept).toHaveLength(UUID_LINES.length)
  })

  it('restamps every kept record with the fork session id', () => {
    const kept = buildForkedSessionLinesAtUuid(UUID_LINES, {
      newSessionId: 'fork-id',
      cutoffUuid: 'uuid-1'
    })
    const ids = kept.map((l) => (JSON.parse(l) as { sessionId?: string }).sessionId)
    expect(ids.every((id) => id === 'fork-id')).toBe(true)
    expect(kept.some((l) => l.includes('turn two'))).toBe(false)
  })
})
