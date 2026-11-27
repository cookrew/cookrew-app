// The Antigravity CLI transcript parser, against REAL agy 1.5.18 sessions
// (tests/fixtures/agy, captured 2026-11-26/27): three-turns.jsonl is a whole
// conversation of three completed turns (a read, a write, a shell command);
// approval-wait.jsonl ends on a run_command call agy held for the person's
// approval — the state herdr's Devin detector misread as `done`.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { agyPromptOf, agyTurnParser, createAgyTraceAccumulator, parseAgyTrace, parseAgyTurns } from '../src/shared/agy-trace'

const fixture = (name: string): string[] =>
  readFileSync(path.join(__dirname, 'fixtures', 'agy', name), 'utf8').split('\n').filter((line) => line.trim() !== '')

const CONVERSATION = 'c51f85ae-a904-4d0d-88c0-817bd71dba49'

describe('agy transcript → trace blocks', () => {
  const blocks = parseAgyTrace(fixture('three-turns.jsonl'), CONVERSATION)

  it('one block per prompt the person typed, numbered from 1', () => {
    expect(blocks.map((b) => b.index)).toEqual([1, 2, 3])
    expect(blocks.map((b) => b.prompt)).toEqual([
      'Read README.md and reply with only its first line.',
      'Create a file hello.txt containing the single word hi.',
      'Run the shell command: rm README.md'
    ])
  })

  it('ids are the prompt step, namespaced by the conversation', () => {
    expect(blocks.map((b) => b.id)).toEqual([`${CONVERSATION}:s0`, `${CONVERSATION}:s4`, `${CONVERSATION}:s8`])
    expect(parseAgyTrace(fixture('three-turns.jsonl')).map((b) => b.id)).toEqual(['s0', 's4', 's8'])
  })

  it('replies, tool calls with decoded args, and results matched by position', () => {
    expect(blocks[0].reply).toBe('# scratch')
    expect(blocks[0].activity.map((a) => a.tool)).toEqual(['read_file'])
    expect(blocks[1].activity.map((a) => a.tool)).toEqual(['write_file'])
    expect(blocks[2].activity[0]).toMatchObject({ tool: 'run_command', args: 'rm README.md' })
    for (const block of blocks) {
      expect(block.activity.every((a) => !/^(Created|Completed) At:/m.test(a.result))).toBe(true)
    }
    expect(blocks[2].reply).toBe('Ran `rm README.md` (exited with code 0).')
  })

  it('a turn ending on a reply with no tool call is final (structural finality)', () => {
    expect(blocks.map((b) => b.final)).toEqual([true, true, true])
    expect(blocks.every((b) => b.endedAt >= b.startedAt)).toBe(true)
  })

  it('a tail holding a tool call that waits for approval stays OPEN', () => {
    const wait = parseAgyTrace(fixture('approval-wait.jsonl'))
    expect(wait.map((b) => b.prompt)).toEqual(['Reply with the single word ok.', 'Run the shell command: touch agy-probe.txt'])
    expect(wait[0].final).toBe(true)
    expect(wait[1].final).toBeUndefined()
    expect(wait[1].activity.map((a) => a.tool)).toEqual(['run_command'])
    const turns = parseAgyTurns(fixture('approval-wait.jsonl'))
    expect(turns.at(-1)?.final).toBeUndefined()
  })

  it('a tail that only started (no reply yet) is open; a later prompt closes the one before it', () => {
    const lines = fixture('three-turns.jsonl')
    const open = parseAgyTurns(lines.slice(0, 2))
    expect(open.at(-1)?.final).toBeUndefined()
    const later = parseAgyTurns([...fixture('approval-wait.jsonl'), lines[0].replace('"step_index": 0', '"step_index": 9').replace('"step_index":0', '"step_index":9')])
    expect(later[1].final).toBe(true)
  })
})

describe('agy parser streaming', () => {
  it('fed in any chunking it equals the whole-file parse', () => {
    const lines = fixture('three-turns.jsonl')
    const whole = parseAgyTrace(lines, CONVERSATION)
    const accumulator = createAgyTraceAccumulator(CONVERSATION)
    for (const line of lines) accumulator.feed([line])
    expect(accumulator.blocks()).toEqual(whole)
  })

  it('a step written twice reads its LATER write, inside the open turn only', () => {
    const lines = fixture('approval-wait.jsonl')
    const step = JSON.parse(lines[3]) as Record<string, unknown>
    const rewritten = JSON.stringify({ ...step, tool_calls: undefined, content: 'Done instead.' })
    const blocks = parseAgyTrace([...lines, rewritten])
    expect(blocks).toHaveLength(2)
    expect(blocks[1].reply).toBe('Done instead.')
    expect(blocks[1].activity).toEqual([])
    expect(blocks[1].final).toBe(true)
    // A step of the closed first turn written again changes nothing.
    const stale = JSON.stringify({ ...(JSON.parse(lines[1]) as object), content: 'late' })
    expect(parseAgyTrace([...lines, stale])[0].reply).toBe('ok')
  })

  it('non-JSON and step-less lines are skipped', () => {
    expect(parseAgyTrace(['', 'not json', '{"type":"USER_INPUT"}', '[]'])).toEqual([])
  })

  it('turn records carry the namespaced ids the trace blocks carry (G3)', () => {
    const lines = fixture('three-turns.jsonl')
    const turns = agyTurnParser(CONVERSATION)(lines)
    expect(turns.map((t) => t.uuid)).toEqual(parseAgyTrace(lines, CONVERSATION).map((b) => b.id))
    expect(turns.map((t) => t.index)).toEqual([1, 2, 3])
  })
})

describe('agy prompt text', () => {
  it('is what the person typed, without agy wrappers', () => {
    expect(agyPromptOf('<USER_REQUEST>\nfix it\nplease\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>')).toBe('fix it\nplease')
    expect(agyPromptOf('plain')).toBe('plain')
    expect(agyPromptOf(null)).toBe('')
  })
})
