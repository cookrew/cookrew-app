// Sol round-2 P0 (finality capability): every harness DECLARES how its
// session file proves a turn ended — 'native' (the parser marks the TAIL
// record final from a marker the harness itself writes) or 'boundary' (only
// a later user prompt closes a record, so a file-backed background dispatch
// can never settle from the file). A 'native' claim is not taken on faith:
// each one is proven here against a real-shaped session fixture. Dispatch
// acceptance reads this capability off the watchSpec — a false 'native'
// strands commissioned work until the sweep.

import { describe, expect, it } from 'vitest'
import { HARNESSES } from '../src/main/harness'

const T0 = Date.parse('2026-08-05T10:00:00.000Z')

/** One COMPLETED turn per harness, in the harness's real end-of-turn shape. */
const COMPLETED: Record<string, string[]> = {
  claude: [
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      message: { role: 'user', content: 'do it' },
      timestamp: new Date(T0).toISOString()
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      timestamp: new Date(T0 + 1000).toISOString()
    })
  ],
  codex: [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 's', cwd: '/w' } }),
    JSON.stringify({
      timestamp: new Date(T0).toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: 'do it' }
    }),
    JSON.stringify({
      timestamp: new Date(T0 + 1000).toISOString(),
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'done' }
    }),
    JSON.stringify({
      timestamp: new Date(T0 + 2000).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'done' }
    })
  ],
  pi: [
    JSON.stringify({
      type: 'message',
      id: 'u1',
      parentId: null,
      message: { role: 'user', content: 'do it', timestamp: T0 }
    }),
    JSON.stringify({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        timestamp: T0 + 1000,
        stopReason: 'stop'
      }
    })
  ]
}

/** The same turn still IN FLIGHT — the tail must stay open. */
const IN_FLIGHT: Record<string, string[]> = {
  claude: COMPLETED.claude.slice(0, 1),
  codex: COMPLETED.codex.slice(0, 3),
  pi: [
    COMPLETED.pi[0],
    JSON.stringify({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'working…' }],
        timestamp: T0 + 1000,
        stopReason: 'toolUse'
      }
    })
  ]
}

describe('harness turn-finality capability', () => {
  it("every harness declares turnFinality: 'native' | 'boundary'", () => {
    for (const harness of HARNESSES) {
      expect(
        ['native', 'boundary'],
        `${harness.id} must declare its end-of-turn proof`
      ).toContain(harness.turnFinality)
    }
  })

  it("'native' requires turns: 'file' — a scrape cannot prove a tail", () => {
    for (const harness of HARNESSES) {
      if (harness.turnFinality === 'native') {
        expect(harness.turns, `${harness.id} claims a file proof with no file`).toBe('file')
      }
    }
  })

  it('claude, codex and pi all prove native finality (background dispatches can settle)', () => {
    const native = HARNESSES.filter((h) => h.turnFinality === 'native').map((h) => h.id).sort()
    expect(native).toEqual(['claude', 'codex', 'pi'])
  })

  for (const harness of HARNESSES.filter((h) => h.turnFinality === 'native')) {
    it(`${harness.id}: the parser DELIVERS the claimed proof on the tail record`, () => {
      const turns = harness.parseTurns!(COMPLETED[harness.id])
      expect(turns).toHaveLength(1)
      // The completed turn's tail is final from the file alone…
      expect(turns.at(-1)?.final, `${harness.id} completed tail`).toBe(true)
      // …and a turn still in flight is NOT final (no false settlement).
      const open = harness.parseTurns!(IN_FLIGHT[harness.id])
      expect(open.at(-1)?.final, `${harness.id} in-flight tail`).toBeUndefined()
    })
  }
})
