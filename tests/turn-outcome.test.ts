// Sol r3 P1 (native failure markers) + P2 (zero-duration codex fallback):
// a turn that ended UNSUCCESSFULLY is still a turn that ENDED. Codex writes
// `turn_aborted`, pi writes stopReason 'aborted'/'error'/'length' — each is
// positive terminal evidence the parsers used to discard, stranding the
// dispatch until the ten-minute sweep. The classification is deliberately
// asymmetric: quiet stays non-terminal everywhere; only a marker the harness
// itself wrote may close a turn, successfully (outcome absent) or not
// (outcome 'failed'/'interrupted'). Claude has NO in-file failure marker —
// an errored Claude turn simply never writes end_turn — so a Claude record
// never carries an outcome, pinned here so nobody fabricates one later.

import { describe, expect, it } from 'vitest'
import { parseSessionTurns } from '../src/shared/session-turns'
import {
  parseCodexTrace,
  parseCodexTurns,
  parsePiTrace,
  parsePiTurns
} from '../src/shared/trace-blocks'

const T0 = Date.parse('2026-08-05T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

// ---- codex: turn_aborted is terminal, and it never moves the clock ----

function codexAborted(): string[] {
  return [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 's', cwd: '/w' } }),
    JSON.stringify({
      timestamp: iso(T0),
      type: 'event_msg',
      payload: { type: 'user_message', message: 'do it' }
    }),
    JSON.stringify({
      timestamp: iso(T0 + 500),
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{}' }
    }),
    JSON.stringify({
      timestamp: iso(T0 + 2000),
      type: 'event_msg',
      payload: { type: 'turn_aborted', reason: 'interrupted' }
    })
  ]
}

describe('codex turn_aborted (Sol r3 P1)', () => {
  it('closes the tail as final with outcome interrupted', () => {
    const blocks = parseCodexTrace(codexAborted())
    expect(blocks).toHaveLength(1)
    expect(blocks[0].final).toBe(true)
    expect(blocks[0].outcome).toBe('interrupted')
    const records = parseCodexTurns(codexAborted())
    expect(records[0].final).toBe(true)
    expect(records[0].outcome).toBe('interrupted')
  })

  it('never moves endedAt — the ledger clocks predate the marker and are ground truth', () => {
    const blocks = parseCodexTrace(codexAborted())
    // Last activity was the tool call at T0+500; the abort at T0+2000 is a
    // finality marker, not work.
    expect(blocks[0].endedAt).toBe(T0 + 500)
  })

  it('a reply arriving after the abort REOPENS the block, clearing outcome too', () => {
    const blocks = parseCodexTrace([
      ...codexAborted(),
      JSON.stringify({
        timestamp: iso(T0 + 3000),
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'actually finishing' }
      })
    ])
    expect(blocks[0].final).toBeUndefined()
    expect(blocks[0].outcome).toBeUndefined()
    expect(blocks[0].reply).toBe('actually finishing')
  })

  it('an aborted NON-TAIL turn keeps its outcome across the next-user boundary', () => {
    const records = parseCodexTurns([
      ...codexAborted(),
      JSON.stringify({
        timestamp: iso(T0 + 9000),
        type: 'event_msg',
        payload: { type: 'user_message', message: 'try again' }
      })
    ])
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ final: true, outcome: 'interrupted' })
    // The fresh tail is open, verdict-free.
    expect(records[1].final).toBeUndefined()
    expect(records[1].outcome).toBeUndefined()
  })
})

// ---- codex: task_complete-only fallback must not fabricate zero duration ----

describe('codex task_complete as the ONLY reply (Sol r3 P2)', () => {
  // Corpus-shaped: transitional/truncated rollouts where no agent_message
  // (old format) nor item_completed AgentMessage (new format) ever landed —
  // task_complete carries the closing reply AND the only closing clock.
  const onlyReply = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 's', cwd: '/w' } }),
    JSON.stringify({
      timestamp: iso(T0),
      type: 'event_msg',
      payload: { type: 'user_message', message: 'do it' }
    }),
    JSON.stringify({
      timestamp: iso(T0 + 4000),
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'done' }
    })
  ]

  it('adopts the task_complete timestamp as endedAt — durationMs is real, not 0', () => {
    const blocks = parseCodexTrace(onlyReply)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ reply: 'done', final: true })
    expect(blocks[0].endedAt).toBe(T0 + 4000)
    expect(blocks[0].endedAt - blocks[0].startedAt).toBe(4000)
  })

  it('with a real reply event the legacy derivation stands — endedAt stays at the reply', () => {
    const withReply = [
      onlyReply[0],
      onlyReply[1],
      JSON.stringify({
        timestamp: iso(T0 + 900),
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'done', phase: 'final_answer' }
      }),
      onlyReply[2]
    ]
    const blocks = parseCodexTrace(withReply)
    // The stored ledger rows were built on the reply clock (the marker lands
    // 100-500ms later); adopting the marker's clock drifted 12/163 real
    // agents on rebuild. Ground truth does not move.
    expect(blocks[0].endedAt).toBe(T0 + 900)
    expect(blocks[0].final).toBe(true)
  })
})

// ---- pi: terminal stopReasons ----

function piTurn(stopReason: string): string[] {
  return [
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
        content: [{ type: 'text', text: 'partial' }],
        timestamp: T0 + 1000,
        stopReason
      }
    })
  ]
}

describe('pi terminal stopReasons (Sol r3 P1)', () => {
  it("'aborted' is final with outcome interrupted", () => {
    const [block] = parsePiTrace(piTurn('aborted'))
    expect(block).toMatchObject({ final: true, outcome: 'interrupted' })
    expect(parsePiTurns(piTurn('aborted'))[0]).toMatchObject({
      final: true,
      outcome: 'interrupted'
    })
  })

  it("'error' is final with outcome failed", () => {
    expect(parsePiTrace(piTurn('error'))[0]).toMatchObject({ final: true, outcome: 'failed' })
  })

  it("'length' is final with outcome failed — the turn ENDED, unsuccessfully", () => {
    // Length is not quiet: pi positively recorded that the limit cut the
    // turn. Quiet stays non-terminal; written evidence of an ending is
    // terminal even when the ending is bad.
    expect(parsePiTrace(piTurn('length'))[0]).toMatchObject({ final: true, outcome: 'failed' })
  })

  it("'stop' is final and SUCCESSFUL — outcome stays absent (absent-final means done)", () => {
    const [block] = parsePiTrace(piTurn('stop'))
    expect(block.final).toBe(true)
    expect(block.outcome).toBeUndefined()
  })

  it("'toolUse' keeps the tail open, verdict-free", () => {
    const [block] = parsePiTrace(piTurn('toolUse'))
    expect(block.final).toBeUndefined()
    expect(block.outcome).toBeUndefined()
  })

  it('a later assistant message re-judges the turn — the LATEST stopReason rules', () => {
    const lines = [
      ...piTurn('aborted'),
      JSON.stringify({
        type: 'message',
        id: 'a2',
        parentId: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'resumed and finished' }],
          timestamp: T0 + 2000,
          stopReason: 'stop'
        }
      })
    ]
    const [block] = parsePiTrace(lines)
    expect(block.final).toBe(true)
    expect(block.outcome).toBeUndefined()
  })

  it('endedAt derivation is untouched by the classification', () => {
    expect(parsePiTrace(piTurn('aborted'))[0].endedAt).toBe(T0 + 1000)
    expect(parsePiTrace(piTurn('stop'))[0].endedAt).toBe(T0 + 1000)
  })
})

// ---- claude: no failure marker exists, so no outcome is ever fabricated ----

describe('claude errored turns write no marker (Sol r3 P1, documented no-op)', () => {
  const user = (uuid: string, content: string, ms: number): string =>
    JSON.stringify({
      type: 'user',
      uuid,
      parentUuid: null,
      message: { role: 'user', content },
      timestamp: iso(ms)
    })

  it('an errored tail stays open; the boundary later closes it with outcome absent', () => {
    const errored = [
      user('u1', 'do it', T0),
      // The API errored mid-turn: the assistant entry exists but no
      // end_turn was ever written — exactly what the file looks like.
      JSON.stringify({
        type: 'assistant',
        timestamp: iso(T0 + 1000),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'partial' }],
          stop_reason: null
        }
      })
    ]
    const open = parseSessionTurns(errored)
    expect(open[0].final).toBeUndefined()
    expect(open[0].outcome).toBeUndefined()
    // The next prompt closes it — as done, because the file holds no
    // failure evidence and silence is not a verdict.
    const closed = parseSessionTurns([...errored, user('u2', 'again', T0 + 5000)])
    expect(closed[0].final).toBe(true)
    expect(closed[0].outcome).toBeUndefined()
  })
})
