// THE FINALITY QUESTION T1 LEFT OPEN, settled (one-stream T2) and RE-CUT AT
// THE BLOCK (D4, T5 QA 2026-09-07).
//
// T1's StreamTailResult documented the gap: Claude's `stop_reason: "end_turn"`
// is read by session-turns.ts and never projected onto trace blocks, so a
// Claude tail always read as OPEN. T2 closed it from a fixed 256 KB tail and
// demanded the window's LAST record be the block — which a tool-heavy turn
// never satisfies (measured: 19 records in the window, the end_turn inside it,
// the block's own prompt 300 KB earlier), so a finished turn read as open
// forever. The window is now the BLOCK'S OWN SPAN.

import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  blockIsClosed,
  FINALITY_MAX_WINDOW_BYTES,
  FINALITY_TAIL_BYTES,
  finalityWindowBytes,
  readFileTail,
  tailIsFinal
} from '../src/main/stream-finality'
import { parseClaudeTraceDocument } from '../src/shared/trace-blocks'
import { tailBlockSpan } from '../src/main/trace'

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

/** A tool_use record and its result — the pair that makes a turn "tool-heavy"
 *  and pushes its own prompt out of a fixed tail window. */
const toolCall = (id: string, bytes: number, ms: number): string[] => [
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(ms),
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/a'.repeat(40) } }],
      stop_reason: 'tool_use'
    }
  }),
  JSON.stringify({
    type: 'user',
    timestamp: iso(ms + 1),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(bytes) }]
    }
  })
]

/** A record the finality rule must IGNORE: it is neither a prompt nor an
 *  assistant entry, so it may only move `endedAt`. */
const attachment = (ms: number): string =>
  JSON.stringify({ type: 'attachment', timestamp: iso(ms), attachment: { kind: 'diagnostics' } })

const whole = (lines: string[]) => ({ text: lines.join('\n'), fromStart: true })

describe('blockIsClosed — Claude’s own end-of-turn marker', () => {
  it('a closing entry with stop_reason "end_turn" closes the turn', () => {
    const window = whole([prompt('u1', 'ask', T0), reply('done', T0 + 1, 'end_turn')])
    expect(blockIsClosed(window, 'u1')).toBe(true)
  })

  it('"tool_use" and null mean MORE of this turn is coming', () => {
    for (const stop of ['tool_use', null]) {
      const window = whole([prompt('u1', 'ask', T0), reply('thinking', T0 + 1, stop)])
      expect(blockIsClosed(window, 'u1')).toBe(false)
    }
  })

  it('a nonempty reply is NOT completion evidence on its own', () => {
    const window = whole([
      prompt('u1', 'ask', T0),
      reply('here is a paragraph of answer', T0 + 1, null)
    ])
    expect(blockIsClosed(window, 'u1')).toBe(false)
  })

  it('the exchange is FOUND, not assumed to be the window’s last record', () => {
    // T2 required the last record to BE the block, and answered `false` for
    // u1 here. That is the D4 bug in miniature: u1 is over — a later exchange
    // exists past it (rule 2) — and only u2 is still open.
    const window = whole([
      prompt('u1', 'first', T0),
      reply('done', T0 + 1, 'end_turn'),
      prompt('u2', 'second', T0 + 2)
    ])
    expect(blockIsClosed(window, 'u1')).toBe(true)
    expect(blockIsClosed(window, 'u2')).toBe(false)
  })

  it('trailing attachment and system records are ignored, not evidence', () => {
    const closed = whole([
      prompt('u1', 'ask', T0),
      reply('done', T0 + 1, 'end_turn'),
      attachment(T0 + 2),
      JSON.stringify({ type: 'system', subtype: 'hook', timestamp: iso(T0 + 3) })
    ])
    expect(blockIsClosed(closed, 'u1')).toBe(true)
    const running = whole([
      prompt('u1', 'ask', T0),
      reply('working', T0 + 1, 'tool_use'),
      attachment(T0 + 2)
    ])
    expect(blockIsClosed(running, 'u1')).toBe(false)
  })

  it('drops a torn first line when the window did not reach the file’s start', () => {
    const torn = {
      text: ['{"type":"assis', prompt('u1', 'ask', T0), reply('done', T0 + 1, 'end_turn')].join('\n'),
      fromStart: false
    }
    expect(blockIsClosed(torn, 'u1')).toBe(true)
  })

  it('an identity the window does not hold says nothing, which is not "finished"', () => {
    expect(blockIsClosed({ text: '', fromStart: true }, 'u1')).toBe(false)
    const other = whole([prompt('u9', 'someone else', T0), reply('done', T0 + 1, 'end_turn')])
    expect(blockIsClosed(other, 'u1')).toBe(false)
  })
})

describe('finalityWindowBytes — the byte cap, as arithmetic', () => {
  it('an unnamed span falls back to the fixed tail window', () => {
    expect(finalityWindowBytes(undefined)).toBe(FINALITY_TAIL_BYTES)
    expect(finalityWindowBytes(Number.NaN)).toBe(FINALITY_TAIL_BYTES)
    expect(finalityWindowBytes(-1)).toBe(FINALITY_TAIL_BYTES)
  })

  it('a named span is read with backoff, never narrower than the fixed one', () => {
    expect(finalityWindowBytes(10)).toBe(FINALITY_TAIL_BYTES)
    const big = 4 * 1024 * 1024
    expect(finalityWindowBytes(big)).toBeGreaterThan(big)
    expect(finalityWindowBytes(big)).toBeLessThanOrEqual(FINALITY_MAX_WINDOW_BYTES)
  })

  it('past the cap the answer is "do not read" — unknown, which reads as open', () => {
    expect(finalityWindowBytes(FINALITY_MAX_WINDOW_BYTES)).toBeNull()
    expect(finalityWindowBytes(FINALITY_MAX_WINDOW_BYTES * 4)).toBeNull()
  })
})

describe('tailIsFinal — the rule as the routes apply it', () => {
  const bed = (lines: string[]): string => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'finality-')), 's1.jsonl')
    writeFileSync(file, `${lines.join('\n')}\n`)
    return file
  }

  /** The span the reader publishes for a file's LAST block, over real lines —
   *  the same arithmetic trace.ts's ingest performs. */
  const spanOf = (file: string, lines: string[]): number => {
    const parsed = parseClaudeTraceDocument(lines)
    // The bed writes a trailing newline, so there is no partial line to carry.
    const span = tailBlockSpan(lines, parsed.blockLines, 0)
    expect(span).not.toBeUndefined()
    expect(span as number).toBeLessThanOrEqual(statSync(file).size)
    return span as number
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
    const lines = [
      prompt('u1', 'first', T0),
      reply('one', T0 + 1, 'end_turn'),
      prompt('u2', 'second', T0 + 2),
      reply('two', T0 + 3, 'end_turn')
    ]
    const file = bed(lines)
    expect(await tailIsFinal({ id: 'u2' }, file, 'claude', {}, spanOf(file, lines))).toBe(true)
  })

  it('an unfinished Claude tail stays OPEN — the conservative direction', async () => {
    const lines = [
      prompt('u1', 'first', T0),
      reply('one', T0 + 1, 'end_turn'),
      prompt('u2', 'second', T0 + 2),
      reply('still working', T0 + 3, null)
    ]
    const file = bed(lines)
    expect(await tailIsFinal({ id: 'u2' }, file, 'claude', {}, spanOf(file, lines))).toBe(false)
  })

  it('an unreadable file is open, never final — silence is not evidence', async () => {
    expect(await tailIsFinal({ id: 'u1' }, '/no/such/file.jsonl', 'claude')).toBe(false)
  })

  // THE D4 INCIDENT, as a fixture. The turn's end_turn sits 300 KB past its
  // own prompt, so a window taken from EOF at any fixed size that does not
  // also reach the prompt reports OPEN — which is what shipped.
  describe('a tool-heavy turn whose end_turn is 300 KB past the block start', () => {
    const heavy = (): string[] => {
      const lines = [prompt('u1', 'first', T0), reply('one', T0 + 1, 'end_turn')]
      lines.push(prompt('u2', 'run the whole suite', T0 + 2))
      // ~300 KB of tool traffic inside the ONE exchange.
      for (let n = 0; n < 20; n += 1) lines.push(...toolCall(`t${n}`, 15_000, T0 + 3 + n))
      lines.push(attachment(T0 + 400))
      lines.push(reply('the suite is green', T0 + 401, 'end_turn'))
      lines.push(attachment(T0 + 402))
      return lines
    }

    it('is FINAL when the window is the block’s own span', async () => {
      const lines = heavy()
      const file = bed(lines)
      const span = spanOf(file, lines)
      expect(span).toBeGreaterThan(300_000)
      expect(await tailIsFinal({ id: 'u2' }, file, 'claude', {}, span)).toBe(true)
    })

    it('was OPEN under the fixed 256 KB tail — the regression this pins', async () => {
      const lines = heavy()
      const file = bed(lines)
      // No span named, and the fixed window cannot reach u2's own prompt.
      expect(await tailIsFinal({ id: 'u2' }, file, 'claude')).toBe(false)
    })

    it('a genuinely open tool-heavy turn still reads open with the span', async () => {
      const lines = heavy()
      lines[lines.length - 2] = reply('still working', T0 + 401, 'tool_use')
      const file = bed(lines)
      expect(await tailIsFinal({ id: 'u2' }, file, 'claude', {}, spanOf(file, lines))).toBe(false)
    })

    it('a span past the cap is not read at all — unknown reads as open', async () => {
      const lines = heavy()
      const file = bed(lines)
      let reads = 0
      const final = await tailIsFinal(
        { id: 'u2' },
        file,
        'claude',
        {
          maxWindowBytes: 1024,
          readTail: async (target, bytes) => {
            reads += 1
            return readFileTail(target, bytes)
          }
        },
        spanOf(file, lines)
      )
      expect(final).toBe(false)
      expect(reads).toBe(0)
    })
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
