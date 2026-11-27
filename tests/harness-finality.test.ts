// Sol round-2 P0 (finality capability): every harness DECLARES how its
// session file proves a turn ended — 'native' (the parser marks the TAIL
// record final from a marker the harness itself writes) or 'boundary' (only
// a later user prompt closes a record, so a file-backed background dispatch
// can never settle from the file). A 'native' claim is not taken on faith:
// each one is proven here against a real-shaped session fixture. Dispatch
// acceptance reads this capability off the watchSpec — a false 'native'
// strands commissioned work until the sweep.

import { describe, expect, it } from 'vitest'
import { HARNESSES, settlesFromFile } from '../src/main/harness'

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
  ],
  // agy (structural): the last step is a reply with no tool call.
  agy: [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-08-05T10:00:00Z', content: '<USER_REQUEST>\nrun it\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-05T10:00:01Z', tool_calls: [{ name: 'run_command', args: { CommandLine: '"touch x"' } }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-08-05T10:00:02Z', content: 'Created At: x\nCompleted At: y\nok' }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-05T10:00:03Z', content: 'Ran it.' })
  ],
  // devin (native): finish_reason 'stop' on a reply with no tool call.
  devin: [
    JSON.stringify({ kind: 'node', at: 1, node: { id: 1, parent_id: null, message: { role: 'user', content: 'run it', metadata: { is_user_input: true, created_at: '2026-08-05T10:00:00Z' } } } }),
    JSON.stringify({ kind: 'node', at: 1, node: { id: 2, parent_id: 1, message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'exec', arguments: { command: 'touch x' } }], metadata: { finish_reason: 'tool_calls', created_at: '2026-08-05T10:00:01Z' } } } }),
    JSON.stringify({ kind: 'node', at: 1, node: { id: 3, parent_id: 2, message: { role: 'tool', content: 'ok', tool_call_id: 'c1', metadata: { created_at: '2026-08-05T10:00:02Z' } } } }),
    JSON.stringify({ kind: 'node', at: 1, node: { id: 4, parent_id: 3, message: { role: 'assistant', content: 'Ran it.', tool_calls: [], metadata: { finish_reason: 'stop', created_at: '2026-08-05T10:00:03Z' } } } })
  ]
}

/**
 * A STRUCTURAL harness's tail waiting for the person: the call is asked,
 * nothing ran. It must read open (herdr reported exactly this state as done).
 */
const APPROVAL_WAIT: Record<string, string[]> = {
  agy: [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-08-05T10:00:00Z', content: '<USER_REQUEST>\nrun it\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-05T10:00:01Z', tool_calls: [{ name: 'run_command', args: { CommandLine: '"touch x"' } }] })
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
  ],
  // agy: the call ran, no reply yet.
  agy: [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-08-05T10:00:00Z', content: '<USER_REQUEST>\nrun it\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-05T10:00:01Z', tool_calls: [{ name: 'run_command', args: { CommandLine: '"touch x"' } }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-08-05T10:00:02Z', content: 'Created At: x\nCompleted At: y\nok' })
  ],
  // devin: the call is asked (an approval wait looks the same), no reply yet.
  devin: [
    JSON.stringify({ kind: 'node', at: 1, node: { id: 1, parent_id: null, message: { role: 'user', content: 'run it', metadata: { is_user_input: true, created_at: '2026-08-05T10:00:00Z' } } } }),
    JSON.stringify({ kind: 'node', at: 1, node: { id: 2, parent_id: 1, message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'exec', arguments: { command: 'touch x' } }], metadata: { finish_reason: 'tool_calls', created_at: '2026-08-05T10:00:01Z' } } } })
  ]
}

describe('harness turn-finality capability', () => {
  it("every harness declares turnFinality: 'native' | 'structural' | 'boundary'", () => {
    for (const harness of HARNESSES) {
      expect(
        ['native', 'structural', 'boundary'],
        `${harness.id} must declare its end-of-turn proof`
      ).toContain(harness.turnFinality)
    }
  })

  it("a file proof ('native' or 'structural') requires turns: 'file' — a scrape cannot prove a tail", () => {
    for (const harness of HARNESSES) {
      if (settlesFromFile(harness.turnFinality)) {
        expect(harness.turns, `${harness.id} claims a file proof with no file`).toBe('file')
      }
    }
  })

  it('claude, codex, pi and devin all prove native finality (background dispatches can settle)', () => {
    const native = HARNESSES.filter((h) => h.turnFinality === 'native').map((h) => h.id).sort()
    expect(native).toEqual(['claude', 'codex', 'devin', 'pi'])
  })

  it('only a file proof lets a background dispatch settle from the file', () => {
    expect(settlesFromFile('native')).toBe(true)
    expect(settlesFromFile('structural')).toBe(true)
    expect(settlesFromFile('boundary')).toBe(false)
  })

  it('structural finality is claimed by agy alone (real-session fixtures: tests/agy-trace.test.ts)', () => {
    expect(HARNESSES.filter((h) => h.turnFinality === 'structural').map((h) => h.id)).toEqual(['agy'])
  })

  for (const harness of HARNESSES.filter((h) => h.turnFinality === 'structural')) {
    it(`${harness.id}: a tail waiting for approval stays OPEN`, () => {
      const waiting = APPROVAL_WAIT[harness.id]
      expect(waiting, `${harness.id} must ship an APPROVAL_WAIT fixture`).toBeDefined()
      expect(harness.parseTurns!(waiting).at(-1)?.final).toBeUndefined()
    })
  }

  for (const harness of HARNESSES.filter((h) => settlesFromFile(h.turnFinality))) {
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
