// THE FINALITY QUESTION T1 LEFT OPEN, settled (one-stream T2).
//
// T1's StreamTailResult documented the gap: Claude's `stop_reason: "end_turn"`
// is read by session-turns.ts and never projected onto trace blocks, so a
// Claude tail always read as OPEN. These are the rules that close it, and the
// conservative direction that keeps a running turn from freezing on a card.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { lastRecordClosed, readFileTail, tailIsFinal } from '../src/main/stream-finality'

const T0 = Date.parse('2026-09-07T09:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

const prompt = (uuid: string, text: string, ms: number): string =>
  JSON.stringify({ type: 'user', uuid, timestamp: iso(ms), message: { role: 'user', content: text } })

const reply = (text: string, ms: number, stop: string | null): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(ms),
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop }
  })

const whole = (lines: string[]) => ({ text: lines.join('\n'), fromStart: true })

describe('lastRecordClosed — Claude’s own end-of-turn marker', () => {
  it('a closing entry with stop_reason "end_turn" closes the turn', () => {
    const window = whole([prompt('u1', 'ask', T0), reply('done', T0 + 1, 'end_turn')])
    expect(lastRecordClosed(window, 'u1')).toBe(true)
  })

  it('"tool_use" and null mean MORE of this turn is coming', () => {
    for (const stop of ['tool_use', null]) {
      const window = whole([prompt('u1', 'ask', T0), reply('thinking', T0 + 1, stop)])
      expect(lastRecordClosed(window, 'u1')).toBe(false)
    }
  })

  it('a nonempty reply is NOT completion evidence on its own', () => {
    const window = whole([
      prompt('u1', 'ask', T0),
      reply('here is a paragraph of answer', T0 + 1, null)
    ])
    expect(lastRecordClosed(window, 'u1')).toBe(false)
  })

  it('an OLDER closed turn never closes the block we asked about', () => {
    // The load-bearing identity check: a window ending on a finished turn
    // must not close a different, still-running one.
    const window = whole([
      prompt('u1', 'first', T0),
      reply('done', T0 + 1, 'end_turn'),
      prompt('u2', 'second', T0 + 2)
    ])
    expect(lastRecordClosed(window, 'u1')).toBe(false)
    expect(lastRecordClosed(window, 'u2')).toBe(false)
  })

  it('drops a torn first line when the window did not reach the file’s start', () => {
    const torn = {
      text: ['{"type":"assis', prompt('u1', 'ask', T0), reply('done', T0 + 1, 'end_turn')].join('\n'),
      fromStart: false
    }
    expect(lastRecordClosed(torn, 'u1')).toBe(true)
  })

  it('an empty window says nothing, which is not "finished"', () => {
    expect(lastRecordClosed({ text: '', fromStart: true }, 'u1')).toBe(false)
  })
})

describe('tailIsFinal — the rule as the routes apply it', () => {
  const bed = (lines: string[]): string => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'finality-')), 's1.jsonl')
    writeFileSync(file, `${lines.join('\n')}\n`)
    return file
  }

  it('a harness marker in the block itself wins, with no read at all', async () => {
    let read = 0
    const final = await tailIsFinal({ id: 'p1', final: true }, '/nope.jsonl', 'codex', {
      readTail: async () => {
        read += 1
        return null
      }
    })
    expect(final).toBe(true)
    expect(read).toBe(0)
  })

  it('a codex or pi tail with no marker is open — their parsers already own it', async () => {
    for (const kind of ['codex', 'pi'] as const) {
      expect(await tailIsFinal({ id: 'p1' }, '/nope.jsonl', kind)).toBe(false)
    }
  })

  it('reads a real Claude transcript’s tail and finds the marker', async () => {
    const file = bed([
      prompt('u1', 'first', T0),
      reply('one', T0 + 1, 'end_turn'),
      prompt('u2', 'second', T0 + 2),
      reply('two', T0 + 3, 'end_turn')
    ])
    expect(await tailIsFinal({ id: 'u2' }, file, 'claude')).toBe(true)
  })

  it('an unfinished Claude tail stays OPEN — the conservative direction', async () => {
    const file = bed([
      prompt('u1', 'first', T0),
      reply('one', T0 + 1, 'end_turn'),
      prompt('u2', 'second', T0 + 2),
      reply('still working', T0 + 3, null)
    ])
    expect(await tailIsFinal({ id: 'u2' }, file, 'claude')).toBe(false)
  })

  it('an unreadable file is open, never final — silence is not evidence', async () => {
    expect(await tailIsFinal({ id: 'u1' }, '/no/such/file.jsonl', 'claude')).toBe(false)
  })
})

describe('readFileTail', () => {
  it('reads only the last bytes, and says whether it reached the start', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'finality-tail-')), 'big.jsonl')
    writeFileSync(file, `${'x'.repeat(1000)}\nTAIL\n`)
    const small = await readFileTail(file, 8)
    expect(small?.fromStart).toBe(false)
    expect(small?.text).toContain('TAIL')
    const all = await readFileTail(file, 1_000_000)
    expect(all?.fromStart).toBe(true)
  })

  it('returns null rather than throwing for a file that is not there', async () => {
    expect(await readFileTail('/no/such/file.jsonl', 1024)).toBeNull()
  })
})
