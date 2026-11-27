// The Devin session-log parser, against a REAL Devin 3000.14 session
// (tests/fixtures/devin, captured 2026-11-26, system context blanked):
// two-turns.jsonl is two completed turns (a read; a write the person
// approved); approval-wait.jsonl stops where Devin asked for that approval.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDevinTraceAccumulator, devinTurnParser, parseDevinTrace, parseDevinTurns } from '../src/shared/devin-trace'

const fixture = (name: string): string[] =>
  readFileSync(path.join(__dirname, 'fixtures', 'devin', name), 'utf8').split('\n').filter((line) => line.trim() !== '')

const SESSION = 'wary-seeker'
const node = (id: number, parent: number | null, message: Record<string, unknown>): string =>
  JSON.stringify({ kind: 'node', at: 1795700000 + id, node: { id, parent_id: parent, message } })

describe('Devin log → trace blocks', () => {
  const blocks = parseDevinTrace(fixture('two-turns.jsonl'), SESSION)

  it('the newest branch holds each prompt once, though Devin wrote the first five times', () => {
    expect(blocks.map((b) => b.prompt)).toEqual(['Read README.md and reply with only its first line.', 'Create a file hello.txt containing the single word hi.'])
    expect(blocks.map((b) => b.index)).toEqual([1, 2])
    expect(blocks.map((b) => b.id)).toEqual([`${SESSION}:28`, `${SESSION}:35`])
  })

  it('replies, tool calls and results matched by call id; sibling duplicates counted once', () => {
    expect(blocks[0].reply).toBe('# scratch')
    expect(blocks[0].activity.map((a) => a.tool)).toEqual(['read'])
    expect(blocks[0].activity[0].result).toContain('# scratch')
    expect(blocks[1].activity.map((a) => a.tool)).toEqual(['find_file_by_name', 'write'])
    expect(blocks[1].activity[1].result).toMatch(/^File created successfully/)
    expect(blocks[1].reply).toBe('Done.')
  })

  it("finish_reason 'stop' with no tool call ends a turn (native finality)", () => {
    expect(blocks.map((b) => b.final)).toEqual([true, true])
  })

  it('a write waiting for approval stays OPEN', () => {
    const waiting = parseDevinTrace(fixture('approval-wait.jsonl'))
    expect(waiting).toHaveLength(2)
    expect(waiting[1].final).toBeUndefined()
    expect(waiting[1].activity.map((a) => a.tool)).toEqual(['find_file_by_name', 'write'])
    expect(parseDevinTurns(fixture('approval-wait.jsonl')).at(-1)?.final).toBeUndefined()
  })
})

describe('Devin parser streaming', () => {
  it('fed line by line it equals the whole-file parse', () => {
    const lines = fixture('two-turns.jsonl')
    const accumulator = createDevinTraceAccumulator(SESSION)
    for (const line of lines) accumulator.feed([line])
    expect(accumulator.blocks()).toEqual(parseDevinTrace(lines, SESSION))
  })

  it('an append to the open turn keeps the same blocks array (no reset)', () => {
    const lines = fixture('two-turns.jsonl')
    const accumulator = createDevinTraceAccumulator()
    accumulator.feed(lines.slice(0, -3))
    const before = accumulator.blocks()
    accumulator.feed(lines.slice(-3))
    expect(accumulator.blocks()).toBe(before)
    expect(before.at(-1)?.final).toBe(true)
  })

  it('a node written again is read in its last form', () => {
    const lines = [
      node(1, null, { role: 'user', content: 'hi', metadata: { is_user_input: true } }),
      node(2, 1, { role: 'assistant', content: 'draft', tool_calls: [], metadata: { finish_reason: null } }),
      node(2, 1, { role: 'assistant', content: 'final', tool_calls: [], metadata: { finish_reason: 'stop' } })
    ]
    expect(parseDevinTrace(lines)[0]).toMatchObject({ reply: 'final', final: true })
  })

  it('a rewind re-roots the branch: the abandoned turn leaves, as a reset', () => {
    const base = [
      node(1, null, { role: 'user', content: 'one', metadata: { is_user_input: true } }),
      node(2, 1, { role: 'assistant', content: 'r1', tool_calls: [], metadata: { finish_reason: 'stop' } }),
      node(3, 2, { role: 'user', content: 'two', metadata: { is_user_input: true } }),
      node(4, 3, { role: 'assistant', content: 'r2', tool_calls: [], metadata: { finish_reason: 'stop' } })
    ]
    const accumulator = createDevinTraceAccumulator()
    accumulator.feed(base)
    const before = accumulator.blocks()
    accumulator.feed([node(5, null, { role: 'user', content: 'again', metadata: { is_user_input: true } })])
    expect(accumulator.blocks().map((b) => b.prompt)).toEqual(['again'])
    expect(accumulator.blocks()).not.toBe(before)
  })

  it('a user message Devin injected (not typed) opens no turn; junk lines are skipped', () => {
    const lines = [
      'not json',
      JSON.stringify({ kind: 'live_row', at: 1 }),
      node(1, null, { role: 'user', content: 'typed', metadata: { is_user_input: true } }),
      node(2, 1, { role: 'user', content: 'reminder', metadata: { is_user_input: null } })
    ]
    expect(parseDevinTrace(lines).map((b) => b.prompt)).toEqual(['typed'])
  })

  it('turn uuids are the namespaced block ids (G3, G6)', () => {
    const lines = fixture('two-turns.jsonl')
    expect(devinTurnParser(SESSION)(lines).map((t) => t.uuid)).toEqual(parseDevinTrace(lines, SESSION).map((b) => b.id))
  })
})
