// Sol round-2 #4b: Codex and Pi get RESUMABLE accumulators with the same
// equivalence property Claude's has — feeding the session lines in ANY
// chunking (including splits mid-turn) is indistinguishable from one
// whole-file parse, and reading records mid-stream never disturbs later
// feeds. This is the proof SessionTurnSync's O(Δbytes) reconcile stands on
// for every 'file' harness, not just Claude.

import { describe, expect, it } from 'vitest'
import { parseCodexTurns, parsePiTurns } from '../src/shared/trace-blocks'
import type { StreamingTurnParser } from '../src/shared/session-turns'

const T0 = Date.parse('2026-08-05T10:00:00.000Z')

function codexLine(ms: number, type: string, payload: unknown): string {
  return JSON.stringify({ timestamp: new Date(ms).toISOString(), type, payload })
}

/** A realistic multi-turn rollout: tools, junk lines, an aborted turn, a
 *  task_complete tail — old-generation events plus a new-generation item. */
function codexLines(): string[] {
  const lines: string[] = [
    codexLine(T0, 'session_meta', { session_id: 's1', timestamp: new Date(T0).toISOString(), cwd: '/w' })
  ]
  for (let turn = 0; turn < 8; turn += 1) {
    const at = T0 + turn * 60_000
    lines.push(codexLine(at, 'event_msg', { type: 'task_started', turn_id: `t${turn}` }))
    lines.push(codexLine(at + 1000, 'event_msg', { type: 'user_message', message: `prompt ${turn} — été 目标` }))
    lines.push(
      codexLine(at + 2000, 'response_item', {
        type: 'custom_tool_call', name: 'shell', input: `ls ${turn}`, call_id: `c${turn}`
      })
    )
    if (turn % 3 === 0) lines.push('not json at all')
    lines.push(
      codexLine(at + 3000, 'response_item', {
        type: 'custom_tool_call_output', call_id: `c${turn}`, output: `out ${turn}`
      })
    )
    lines.push(codexLine(at + 4000, 'event_msg', { type: 'agent_message', message: `working ${turn}` }))
    lines.push(codexLine(at + 5000, 'event_msg', { type: 'agent_message', message: `reply ${turn} ✓` }))
    if (turn === 5) {
      lines.push(codexLine(at + 6000, 'event_msg', { type: 'turn_aborted', turn_id: `t${turn}` }))
    } else {
      lines.push(
        codexLine(at + 6000, 'event_msg', {
          type: 'task_complete', turn_id: `t${turn}`, last_agent_message: `reply ${turn} ✓`
        })
      )
    }
    lines.push(codexLine(at + 6500, 'event_msg', { type: 'token_count' }))
  }
  // One new-generation exchange at the tail.
  const at = T0 + 9 * 60_000
  lines.push(
    codexLine(at, 'event_msg', {
      type: 'item_completed', turn_id: 't9',
      item: { type: 'UserMessage', id: 'u9', content: [{ type: 'text', text: 'new-format prompt' }] }
    })
  )
  lines.push(
    codexLine(at + 1000, 'event_msg', {
      type: 'item_completed', turn_id: 't9',
      item: { type: 'AgentMessage', id: 'a9', content: [{ type: 'Text', text: 'new-format reply' }], phase: 'final_answer' }
    })
  )
  lines.push(
    codexLine(at + 2000, 'event_msg', { type: 'task_complete', turn_id: 't9', last_agent_message: 'new-format reply' })
  )
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

/** A realistic pi tree: tool calls, an abandoned branch, junk, a stop tail. */
function piLines(): string[] {
  const lines: string[] = [JSON.stringify({ type: 'session', id: 'sess', cwd: '/w' })]
  let parent: string | null = null
  for (let turn = 0; turn < 6; turn += 1) {
    const at = T0 + turn * 60_000
    lines.push(piMessage(`u${turn}`, parent, 'user', `prompt ${turn} — naïve 完成`, at))
    lines.push(
      piMessage(`t${turn}`, `u${turn}`, 'assistant', [
        { type: 'text', text: `thinking ${turn}` },
        { type: 'toolCall', id: `call${turn}`, name: 'bash', arguments: { command: `ls ${turn}` } }
      ], at + 1000, { stopReason: 'toolUse' })
    )
    if (turn % 2 === 0) lines.push('{broken json')
    lines.push(
      piMessage(`r${turn}`, `t${turn}`, 'toolResult', `out ${turn}`, at + 2000, { toolCallId: `call${turn}` })
    )
    lines.push(
      piMessage(`a${turn}`, `r${turn}`, 'assistant', [{ type: 'text', text: `reply ${turn}` }], at + 3000, {
        stopReason: turn === 3 ? 'aborted' : 'stop'
      })
    )
    if (turn === 2) {
      // Abandoned branch — never continued, must not leak into the record.
      lines.push(piMessage(`x${turn}`, `a${turn}`, 'user', 'abandoned', at + 4000))
    }
    parent = `a${turn}`
  }
  return lines
}

/** Deterministic LCG so a failing split is reproducible from its seed. */
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

const CASES: Array<{ id: string; parse: StreamingTurnParser; lines: () => string[] }> = [
  { id: 'codex', parse: parseCodexTurns, lines: codexLines },
  { id: 'pi', parse: parsePiTurns, lines: piLines }
]

for (const { id, parse, lines } of CASES) {
  describe(`${id} accumulator — split equivalence`, () => {
    it('produces identical records for randomized chunk boundaries (30 seeded trials)', () => {
      const all = lines()
      const whole = parse(all)
      expect(whole.length).toBeGreaterThan(3)
      for (let seed = 1; seed <= 30; seed += 1) {
        const accumulator = parse.createAccumulator()
        for (const chunk of chunked(all, lcg(seed))) accumulator.feed(chunk)
        expect(accumulator.records(), `seed ${seed}`).toEqual(whole)
      }
    })

    it('matches the whole-file parse at EVERY prefix, one line per feed', () => {
      const all = lines()
      const accumulator = parse.createAccumulator()
      for (let i = 0; i < all.length; i += 1) {
        accumulator.feed([all[i]])
        expect(accumulator.records(), `prefix ${i + 1}`).toEqual(parse(all.slice(0, i + 1)))
      }
    })

    it('reading records mid-stream returns a stable snapshot — later feeds do not mutate it', () => {
      const all = lines()
      const accumulator = parse.createAccumulator()
      accumulator.feed(all.slice(0, Math.floor(all.length / 2)))
      const early = accumulator.records()
      const snapshot = JSON.parse(JSON.stringify(early)) as unknown
      accumulator.feed(all.slice(Math.floor(all.length / 2)))
      expect(early).toEqual(snapshot)
    })

    it('a turn split across feeds finalizes exactly when the evidence arrives', () => {
      const all = lines()
      const whole = parse(all)
      const accumulator = parse.createAccumulator()
      // Feed everything but the last turn's closing marker, then the rest:
      // finality of the tail flips only once the marker/boundary lands.
      accumulator.feed(all.slice(0, all.length - 1))
      const openTail = accumulator.records().at(-1)
      accumulator.feed(all.slice(all.length - 1))
      expect(accumulator.records()).toEqual(whole)
      expect(openTail?.final).toBeUndefined()
      expect(accumulator.records().at(-1)?.final).toBe(true)
    })
  })
}
