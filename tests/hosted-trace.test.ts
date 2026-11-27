// The transcript Cookrew's ACP host writes (shared/hosted-trace.ts), against
// REAL transcripts from the host running DeepSeek Harness (fixtures captured
// 2026-11-28: two turns; one approval answered).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHostedTraceAccumulator, hostedTurnParser, parseHostedTrace, parseHostedTurns } from '../src/shared/hosted-trace'

const fixture = (name: string): string[] =>
  readFileSync(path.join(__dirname, 'fixtures', 'hosted', name), 'utf8').split('\n').filter((line) => line.trim() !== '')

const SID = 'addff6fc-dbb7-4d65-9721-250105b33631'

describe('a hosted transcript → trace blocks', () => {
  const blocks = parseHostedTrace(fixture('dsh-two-turns.jsonl'), SID)

  it('one block per prompt, ids namespaced by the session', () => {
    expect(blocks.map((b) => b.prompt)).toEqual(['Read README.md and reply with only its first line.', 'Run this shell command and reply done: touch /tmp/acp-outside-probe.txt'])
    expect(blocks.map((b) => b.id)).toEqual([`${SID}:u1`, `${SID}:u2`])
    expect(blocks.map((b) => b.index)).toEqual([1, 2])
  })

  it('replies, thoughts, tool calls and results', () => {
    expect(blocks[0].reply).toBe('# host probe')
    // The host records thinking as the agent sends it: the first turn read the file straight away.
    expect(blocks[0].thoughts).toBeUndefined()
    expect(blocks[1].thoughts?.map((t) => t.text)).toEqual([expect.stringContaining('outside the workspace'), expect.stringContaining('let me verify')])
    expect(blocks[0].activity).toEqual([expect.objectContaining({ tool: 'read', result: expect.stringContaining('# host probe') })])
  })

  it("the host's end record proves the turn ended (native finality); an error and a cancel are outcomes", () => {
    expect(blocks.map((b) => b.final)).toEqual([true, true])
    const lines = [
      JSON.stringify({ t: 'user', text: 'a' }),
      JSON.stringify({ t: 'text', message: 'm', text: 'partial' }),
      JSON.stringify({ t: 'error', message: 'connection lost' }),
      JSON.stringify({ t: 'end', stop: 'error' }),
      JSON.stringify({ t: 'user', text: 'b' }),
      JSON.stringify({ t: 'end', stop: 'cancelled' })
    ]
    const [a, b] = parseHostedTrace(lines)
    expect(a).toMatchObject({ reply: 'partial', final: true, outcome: 'failed' })
    expect(b).toMatchObject({ final: true, outcome: 'interrupted' })
  })

  it('a turn waiting for approval has no end record yet: open', () => {
    const waiting = parseHostedTrace(fixture('dsh-approval.jsonl'))
    const before = waiting[0]
    expect(before.final).toBe(true) // its own end came before the second turn
    const lines = fixture('dsh-approval.jsonl')
    const at = lines.findIndex((l) => l.includes('"t":"permission"'))
    const cut = parseHostedTrace(lines.slice(0, at + 1))
    expect(cut[cut.length - 1].final).toBeUndefined()
  })

  it('chunks of one message join into a paragraph; a new message starts another', () => {
    const lines = [
      JSON.stringify({ t: 'user', text: 'q' }),
      JSON.stringify({ t: 'text', message: 'm1', text: 'first ' }),
      JSON.stringify({ t: 'text', message: 'm1', text: 'part' }),
      JSON.stringify({ t: 'text', message: 'm2', text: 'second' }),
      JSON.stringify({ t: 'end', stop: 'end_turn' })
    ]
    expect(parseHostedTrace(lines)[0].reply).toBe('first part\n\nsecond')
  })

  it('streaming equals the whole-file parse; turn uuids are block ids (G3, G6)', () => {
    const lines = fixture('dsh-two-turns.jsonl')
    const accumulator = createHostedTraceAccumulator(SID)
    for (const line of lines) accumulator.feed([line])
    expect(accumulator.blocks()).toEqual(parseHostedTrace(lines, SID))
    expect(hostedTurnParser(SID)(lines).map((t) => t.uuid)).toEqual(parseHostedTrace(lines, SID).map((b) => b.id))
    expect(parseHostedTurns(lines).every((t, i, all) => i === all.length - 1 || t.final === true)).toBe(true)
  })
})
