// THE TRACE CACHE KEEPS THE TAIL EXCHANGE, NOT THE FILE (OOM, 2026-10-30).
//
// Every cached transcript used to retain its WHOLE file as a line array,
// only so the last block's byte span could be summed backwards. With the
// canvas polling every card inside the 15 s residency pin, nothing was ever
// evicted: the main process held about 2.5 GB of raw JSONL lines five
// minutes after boot and died at its ~3 GB heap ceiling ("Allocation
// failed - JavaScript heap out of memory").
//
// The span only ever sums the lines from the last block's opener to EOF,
// and openers only move forward, so the entry keeps that SUM and no lines.
// These tests pin both halves: nothing line-shaped is retained, and the span
// is still the one a reader that never saw the file computes, after every
// append.

import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import { TAIL_BLOCK_SPAN_CAP, TraceReader, tailBlockSpan, tailLineBytesAfter } from '../src/main/trace'

const T0 = Date.parse('2026-10-30T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const user = (uuid: string, text: string, ms: number, parentUuid?: string): string =>
  JSON.stringify({ type: 'user', uuid, ...(parentUuid ? { parentUuid } : {}), timestamp: iso(ms), message: { role: 'user', content: text } })
const toolUse = (uuid: string, id: string, ms: number): string =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: iso(ms),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `run ${id}` } }], stop_reason: 'tool_use' }
  })
const toolResult = (id: string, ms: number): string =>
  JSON.stringify({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `out ${id} ${'x'.repeat(200)}` }] } })
const reply = (uuid: string, text: string, ms: number): string =>
  JSON.stringify({ type: 'assistant', uuid, timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } })

/** `n` closed exchanges and one open one: the open tail is three lines. */
function session(n: number): string[] {
  const lines = [JSON.stringify({ type: 'mode', sessionId: 's' })]
  let parent: string | undefined
  for (let i = 0; i < n; i += 1) {
    const at = T0 + i * 10_000
    lines.push(user(`u${i}`, `ask ${i}`, at, parent), toolUse(`t${i}`, `tu${i}`, at + 1000), toolResult(`tu${i}`, at + 2000), reply(`a${i}`, `done ${i}`, at + 3000))
    parent = `a${i}`
  }
  const open = T0 + n * 10_000
  lines.push(user('uo', 'still open', open, parent), toolUse('to', 'tuo', open + 1000), toolResult('tuo', open + 2000))
  return lines
}

type Retained = Record<string, unknown>

/** Any property that is an array of strings — the shape the file's lines had. */
const lineArrays = (entry: Retained): string[] =>
  Object.entries(entry)
    .filter(([, v]) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string'))
    .map(([k]) => k)

function bed(kind: 'claude' | 'codex', initial: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'tail-retention-'))
  const file = path.join(root, `${kind}.jsonl`)
  writeFileSync(file, `${initial.join('\n')}\n`)
  const reader = new TraceReader(new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'tail-retention-ws-'))), { projectsDir: root })
  const retained = (): Retained => {
    const cache = (reader as unknown as { cache: Map<string, Retained> }).cache
    const entry = cache.get(file)
    if (!entry) throw new Error('no cache entry')
    return entry
  }
  return { file, reader, retained }
}

async function freshSpan(file: string): Promise<number | undefined> {
  const reader = new TraceReader(new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'tail-retention-fresh-'))), { projectsDir: path.dirname(file) })
  return (await reader.documentOf(file, 'claude')).tailBlockBytes
}

describe('the trace cache retains the tail exchange only', () => {
  it('a Claude transcript of 200 exchanges retains no lines, and spans the open exchange', async () => {
    const lines = session(200)
    const { file, reader, retained } = bed('claude', lines)
    const doc = await reader.documentOf(file, 'claude')
    expect(doc.blocks).toHaveLength(201)
    expect(lineArrays(retained())).toEqual([])
    expect(doc.tailBlockBytes).toBe(Buffer.byteLength(`${lines.slice(-3).join('\n')}\n`))
  })

  it('an append inside the open exchange extends the span; a new exchange restarts it', async () => {
    const { file, reader, retained } = bed('claude', session(5))
    await reader.documentOf(file, 'claude')

    appendFileSync(file, `${reply('ao', 'open done', T0 + 60_000)}\n`)
    const extended = await reader.documentOf(file, 'claude')
    expect(lineArrays(retained())).toEqual([])
    expect(extended.tailBlockBytes).toBe(Buffer.byteLength(`${[...session(5).slice(-3), reply('ao', 'open done', T0 + 60_000)].join('\n')}\n`))
    expect(extended.tailBlockBytes).toBe(await freshSpan(file))

    const next = [user('un', 'next ask', T0 + 70_000, 'ao'), toolUse('tn', 'tun', T0 + 71_000)]
    appendFileSync(file, `${next.join('\n')}\n`)
    const restarted = await reader.documentOf(file, 'claude')
    expect(lineArrays(retained())).toEqual([])
    expect(restarted.tailBlockBytes).toBe(Buffer.byteLength(`${next.join('\n')}\n`))
    expect(restarted.tailBlockBytes).toBe(await freshSpan(file))
  })

  it('an append that opens and closes several exchanges spans only the last', async () => {
    const { file, reader, retained } = bed('claude', session(2))
    await reader.documentOf(file, 'claude')
    const more = [
      reply('ao', 'open done', T0 + 30_000),
      user('ux', 'x', T0 + 40_000, 'ao'),
      reply('ax', 'x done', T0 + 41_000),
      user('uy', 'y', T0 + 50_000, 'ax'),
      toolUse('ty', 'tuy', T0 + 51_000)
    ]
    appendFileSync(file, `${more.join('\n')}\n`)
    const doc = await reader.documentOf(file, 'claude')
    expect(lineArrays(retained())).toEqual([])
    expect(doc.tailBlockBytes).toBe(Buffer.byteLength(`${more.slice(-2).join('\n')}\n`))
    expect(doc.tailBlockBytes).toBe(await freshSpan(file))
  })

  it('a partial last line is still counted through the remainder', async () => {
    const { file, reader } = bed('claude', session(3))
    await reader.documentOf(file, 'claude')
    appendFileSync(file, '{"type":"assistant","uuid":"half')
    const doc = await reader.documentOf(file, 'claude')
    expect(doc.tailBlockBytes).toBe(await freshSpan(file))
  })

  it('a Codex transcript retains no lines either, and has no span', async () => {
    const codex = [
      JSON.stringify({ timestamp: iso(T0), type: 'session_meta', payload: { id: 'c1' } }),
      JSON.stringify({ timestamp: iso(T0 + 1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } })
    ]
    const { file, reader, retained } = bed('codex', codex)
    const doc = await reader.documentOf(file, 'codex')
    expect(lineArrays(retained())).toEqual([])
    expect(doc.tailBlockBytes).toBeUndefined()
  })
})

describe('tailLineBytesAfter carries tailBlockSpan across appends', () => {
  const lines = ['aa', 'bbb', 'c', 'dddd', 'ee']
  it('agrees with the whole-line sum at every split, for every opener', () => {
    for (const opener of [0, 1, 2, 3, 4]) {
      const whole = tailBlockSpan(lines, [opener], 0)
      for (let split = 0; split <= lines.length; split += 1) {
        const first = tailLineBytesAfter(opener < split ? [opener] : [], 0, lines.slice(0, split), undefined)
        expect(tailLineBytesAfter([opener], split, lines.slice(split), first)).toBe(whole)
      }
    }
  })

  it('no block yet is no span', () => {
    expect(tailLineBytesAfter([], 0, lines, undefined)).toBeUndefined()
  })

  it('past the cap it stops summing and stays past it', () => {
    const big = 'x'.repeat(TAIL_BLOCK_SPAN_CAP)
    const over = tailLineBytesAfter([0], 0, [big, 'y'], undefined) as number
    expect(over).toBeGreaterThan(TAIL_BLOCK_SPAN_CAP)
    expect(tailLineBytesAfter([0], 2, ['z'], over)).toBe(over)
  })
})

