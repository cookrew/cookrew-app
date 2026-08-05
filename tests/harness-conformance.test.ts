// PERMANENT harness-integration gate (harness-integration-contract): adding a
// new agent harness is ONE entry in the registry, and that entry must
// consciously declare its turn-history capability. A 'file' harness without a
// working parser — or a parser whose indices drift from the trace blocks the
// checkpoint rail reads — fails this suite. Do not weaken these assertions to
// land a new harness; implement the capability instead.

import { describe, expect, it } from 'vitest'
import { HARNESSES } from '../src/main/harness'
import { parseClaudeTrace, parseCodexTrace, parsePiTrace } from '../src/shared/trace-blocks'
import { parseSessionTurns } from '../src/shared/session-turns'

describe('harness registry conformance', () => {
  it('every harness declares a turn-history capability', () => {
    for (const harness of HARNESSES) {
      expect(['file', 'scrape'], `${harness.id} must declare turns: 'file' | 'scrape'`).toContain(
        harness.turns
      )
    }
  })

  it("'file' capability ⇔ parser AND watch-file resolver wired, never partial", () => {
    for (const harness of HARNESSES) {
      if (harness.turns === 'file') {
        expect(typeof harness.parseTurns, `${harness.id} declares 'file' but has no parser`).toBe('function')
        expect(typeof harness.watchFile, `${harness.id} declares 'file' but has no watchFile`).toBe('function')
      } else {
        expect(harness.parseTurns, `${harness.id} declares 'scrape' but wires a parser`).toBeUndefined()
        expect(harness.watchFile, `${harness.id} declares 'scrape' but wires a watchFile`).toBeUndefined()
      }
    }
  })

  it('claude, codex and pi all carry file-derived history (the general-agent baseline)', () => {
    const byId = new Map(HARNESSES.map((h) => [h.id, h]))
    for (const id of ['claude', 'codex', 'pi'] as const) {
      expect(byId.get(id)?.turns, `${id} lost file-derived turn history`).toBe('file')
    }
  })

  it('every harness validates its resume key before it can reach a shell command', () => {
    const byId = new Map(HARNESSES.map((h) => [h.id, h]))
    // Closed alphabets reject traversal/metacharacters outright.
    expect(byId.get('pi')!.resumeKey('../../etc/passwd')).toBeNull()
    expect(byId.get('pi')!.resumeKey('x; rm -rf /')).toBeNull()
    expect(byId.get('opencode')!.resumeKey('../../etc/passwd')).toBeNull()
    expect(byId.get('codex')!.resumeKey('not-a-uuid; echo hi')).toBeNull()
    // Claude's pass-through key is guarded upstream (resolveClaudeSessionId
    // drops invalid ids before they reach paths/commands) — pin that the
    // resolver-facing contract at least rejects empties.
    expect(byId.get('claude')!.resumeKey('')).toBeNull()
  })
})

describe('turn/trace identity alignment (phantom-offset gate)', () => {
  // One identity space: TurnRecord.index (card pager, titles) MUST equal
  // TraceBlock.index (checkpoint rail, rewind picker) on the same session
  // lines, for every 'file' harness.
  const T0 = Date.parse('2026-08-05T10:00:00.000Z')

  const claudeLines = [
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'one' }, timestamp: new Date(T0).toISOString() }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'r1' }] }, timestamp: new Date(T0 + 1000).toISOString() }),
    JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: 'two' }, timestamp: new Date(T0 + 2000).toISOString() })
  ]
  const codexLines = [
    JSON.stringify({ timestamp: new Date(T0).toISOString(), type: 'session_meta', payload: { session_id: 's', timestamp: new Date(T0).toISOString(), cwd: '/w' } }),
    JSON.stringify({ timestamp: new Date(T0 + 1000).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'one' } }),
    JSON.stringify({ timestamp: new Date(T0 + 2000).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'two' } })
  ]
  const piLines = [
    JSON.stringify({ type: 'session', id: 's', cwd: '/w' }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'one', timestamp: T0 } }),
    JSON.stringify({ type: 'message', id: 'u2', parentId: 'u1', message: { role: 'user', content: 'two', timestamp: T0 + 1000 } })
  ]

  const cases: Array<{ id: string; lines: string[]; trace: (l: string[]) => { index: number }[] }> = [
    { id: 'claude', lines: claudeLines, trace: parseClaudeTrace },
    { id: 'codex', lines: codexLines, trace: parseCodexTrace },
    { id: 'pi', lines: piLines, trace: parsePiTrace }
  ]

  for (const { id, lines, trace } of cases) {
    it(`${id}: turn indices === trace block indices`, () => {
      const harness = HARNESSES.find((h) => h.id === id)
      expect(harness?.parseTurns).toBeTypeOf('function')
      const turns = harness!.parseTurns!(lines)
      expect(turns.map((t) => t.index)).toEqual(trace(lines).map((b) => b.index))
      expect(turns.length).toBeGreaterThan(0)
    })
  }

  it('claude parser stays the shared session-turns implementation', () => {
    const harness = HARNESSES.find((h) => h.id === 'claude')
    expect(harness?.parseTurns).toBe(parseSessionTurns)
  })
})
