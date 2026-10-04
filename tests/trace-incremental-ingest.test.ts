// AN APPEND PARSES THE APPENDED LINES, AND NOTHING ELSE (perf, 2026-10-04).
//
// trace.ts read only the new bytes of a grown transcript and then re-ran the
// parser over EVERY retained line — "incremental I/O, not incremental parse",
// its own header said. On the owner's live card that was a 5,264-line, 20 MB
// file parsed from the top for every poll that saw it grow: 300 to 600 ms of
// main-thread time, once a second, for one subscriber.
//
// Two claims, both structural:
//
//   1. The Claude parser as a resumable accumulator agrees with the whole-file
//      parse at EVERY split point — blocks, compact markers and block lines —
//      including a split that lands inside an exchange, between a tool call
//      and its result, between two siblings of one submission, and right after
//      a compact boundary. Codex and Pi already had this shape.
//
//   2. TraceReader, handed a grown file, calls JSON.parse exactly as many times
//      as there are new lines. No machine can be fast enough to fake that.

import { appendFileSync, mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import type { TerminalNodeData } from '../src/shared/model'
import { TraceReader } from '../src/main/trace'
import {
  createClaudeTraceAccumulator,
  parseClaudeTraceDocument,
  parseCodexTrace
} from '../src/shared/trace-blocks'

const T0 = Date.parse('2026-10-04T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

const user = (uuid: string, text: string, ms: number, parentUuid?: string): string =>
  JSON.stringify({
    type: 'user',
    uuid,
    ...(parentUuid !== undefined ? { parentUuid } : {}),
    timestamp: iso(ms),
    message: { role: 'user', content: text }
  })
const toolUse = (uuid: string, id: string, ms: number): string =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: iso(ms),
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: `calling ${id}` },
        { type: 'tool_use', id, name: 'Bash', input: { command: `run ${id}` } }
      ],
      stop_reason: 'tool_use'
    }
  })
const toolResult = (id: string, ms: number): string =>
  JSON.stringify({
    type: 'user',
    timestamp: iso(ms),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `out ${id}` }] }
  })
const reply = (uuid: string, text: string, ms: number): string =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: iso(ms),
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }
  })
const compact = (): string =>
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 100 }
  })

/**
 * A session with every shape the fold has state for: noise, a tool exchange,
 * two siblings of one submission (same parentUuid), a compact boundary with a
 * block after it, and an OPEN tail (a prompt whose reply has not landed).
 */
function session(): string[] {
  return [
    JSON.stringify({ type: 'mode', sessionId: 's' }),
    user('u1', 'first ask', T0),
    toolUse('a1', 'tu1', T0 + 1000),
    toolResult('tu1', T0 + 2000),
    toolUse('a2', 'tu2', T0 + 2500),
    toolResult('tu2', T0 + 3000),
    reply('a3', 'first done', T0 + 4000),
    // One submission, two records: the second is a sibling (same parent),
    // which collapses INTO the current block and re-binds its identity.
    user('u2', 'second ask', T0 + 9000, 'a3'),
    user('u2b', 'second ask, edited', T0 + 9100, 'a3'),
    reply('a4', 'second done', T0 + 10000),
    compact(),
    user('u3', 'third ask after compaction', T0 + 20000, 'a4'),
    reply('a5', 'third done', T0 + 21000),
    user('u4', 'fourth ask, still open', T0 + 30000, 'a5'),
    toolUse('a6', 'tu3', T0 + 31000)
  ]
}

describe('the Claude accumulator agrees with the whole-file parse at every split', () => {
  const lines = session()
  const whole = parseClaudeTraceDocument(lines)

  it('the fixture exercises the fold: four blocks, a collapsed sibling, a marker, an open tail', () => {
    expect(whole.blocks).toHaveLength(4)
    expect(whole.blocks[1].id).toBe('u2b')
    expect(whole.blocks[1].prompt).toBe('second ask, edited')
    expect(whole.markers).toEqual([{ kind: 'compact', afterIndex: 2, preTokens: 1000, postTokens: 100 }])
    expect(whole.blocks[0].activity.map((call) => call.result)).toEqual(['out tu1', 'out tu2'])
    expect(whole.blocks[3].reply).toBe('calling tu3')
    expect(whole.blockLines).toEqual([1, 7, 11, 13])
  })

  it.each(lines.map((_, at) => at))('split after line %i', (at) => {
    const accumulator = createClaudeTraceAccumulator()
    accumulator.feed(lines.slice(0, at))
    accumulator.feed(lines.slice(at))
    expect(accumulator.blocks()).toEqual(whole.blocks)
    expect(accumulator.markers()).toEqual(whole.markers)
    expect(accumulator.blockLines()).toEqual(whole.blockLines)
  })

  it('one line at a time is the same document too', () => {
    const accumulator = createClaudeTraceAccumulator()
    for (const line of lines) accumulator.feed([line])
    expect(accumulator.blocks()).toEqual(whole.blocks)
    expect(accumulator.markers()).toEqual(whole.markers)
    expect(accumulator.blockLines()).toEqual(whole.blockLines)
  })

  it('an open tail is extended in place when its reply lands', () => {
    const accumulator = createClaudeTraceAccumulator()
    accumulator.feed(lines)
    const open = accumulator.blocks()[3]
    accumulator.feed([toolResult('tu3', T0 + 32000), reply('a7', 'fourth done', T0 + 33000)])
    expect(accumulator.blocks()).toHaveLength(4)
    expect(accumulator.blocks()[3]).toBe(open)
    expect(open.reply).toBe('calling tu3\nfourth done')
    expect(open.activity[0].result).toBe('out tu3')
  })
})

describe('TraceReader parses only what was appended', () => {
  const roots: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function bed(kind: 'claude' | 'codex', initial: string[]) {
    const root = mkdtempSync(path.join(tmpdir(), 'ingest-'))
    roots.push(root)
    mkdirSync(root, { recursive: true })
    const file = path.join(root, `${kind}.jsonl`)
    writeFileSync(file, `${initial.join('\n')}\n`)
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'ingest-ws-')))
    const reader = new TraceReader(store, { projectsDir: root })
    return { file, reader }
  }

  /** JSON.parse calls made while `run` runs — every parsed line is one. */
  async function parsesDuring<T>(run: () => Promise<T>): Promise<{ value: T; parses: number }> {
    const spy = vi.spyOn(JSON, 'parse')
    const before = spy.mock.calls.length
    const value = await run()
    const parses = spy.mock.calls.length - before
    spy.mockRestore()
    return { value, parses }
  }

  it('Claude: an appended exchange costs its own lines, and the document equals a fresh read', async () => {
    const { file, reader } = bed('claude', session())
    const first = await reader.documentOf(file, 'claude')
    expect(first.blocks).toHaveLength(4)
    const appended = [toolResult('tu3', T0 + 32000), reply('a7', 'fourth done', T0 + 33000), user('u5', 'fifth', T0 + 40000, 'a7')]
    appendFileSync(file, `${appended.join('\n')}\n`)
    const { value: grown, parses } = await parsesDuring(() => reader.documentOf(file, 'claude'))
    expect(parses).toBe(appended.length)
    expect(grown.blocks).toHaveLength(5)
    // The same answer a reader that had never seen the file gives.
    const fresh = await new TraceReader(new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'ingest-ws2-'))), {
      projectsDir: path.dirname(file)
    }).documentOf(file, 'claude')
    expect(grown.blocks).toEqual(fresh.blocks)
    expect(grown.markers).toEqual(fresh.markers)
    expect(grown.bytesRead).toBe(fresh.bytesRead)
    expect(grown.tailBlockBytes).toBe(fresh.tailBlockBytes)
  })

  it('Claude: a shrink (a /rewind truncation) is a fresh parse of what remains', async () => {
    const { file, reader } = bed('claude', session())
    await reader.documentOf(file, 'claude')
    const kept = session().slice(0, 10)
    const text = `${kept.join('\n')}\n`
    truncateSync(file, Buffer.byteLength(text))
    const { value: shrunk, parses } = await parsesDuring(() => reader.documentOf(file, 'claude'))
    expect(parses).toBe(kept.length)
    expect(shrunk.blocks).toHaveLength(2)
    expect(shrunk.blocks).toEqual(parseClaudeTraceDocument(kept).blocks)
  })

  it('Claude: the listing, the refs and the markers all follow an append', async () => {
    // These three memos used to key on the block ARRAY's identity, which an
    // in-place append no longer changes. They key on the bytes read now; this
    // is the case that would have served the pre-append answer forever.
    const root = mkdtempSync(path.join(tmpdir(), 'ingest-memo-'))
    const cwd = '/work/repo'
    const dir = path.join(root, claudeProjectSlug(cwd))
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'sess.jsonl')
    writeFileSync(file, `${session().join('\n')}\n`)
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'ingest-memo-ws-')))
    const node = store.addNode({
      kind: 'terminal',
      id: 't-memo',
      name: 'Agent',
      preset: 'Claude Code',
      command: 'claude',
      cwd,
      orch: false,
      role: null,
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 },
      claudeSessionId: 'sess'
    } as TerminalNodeData) as TerminalNodeData
    const reader = new TraceReader(store, { projectsDir: root })
    expect((await reader.index(node.id)).map((e) => e.index)).toEqual([1, 2, 3, 4])
    expect((await reader.checkpointRefs(node.id)).map((r) => r.index)).toEqual([1, 2, 3, 4])
    expect(await reader.boundaryMarkers(node.id)).toHaveLength(1)
    appendFileSync(
      file,
      `${[toolResult('tu3', T0 + 32000), reply('a7', 'fourth done', T0 + 33000), compact(), user('u5', 'fifth', T0 + 40000, 'a7')].join('\n')}\n`
    )
    expect((await reader.index(node.id)).map((e) => e.index)).toEqual([1, 2, 3, 4, 5])
    expect((await reader.checkpointRefs(node.id)).map((r) => r.index)).toEqual([1, 2, 3, 4, 5])
    expect((await reader.boundaryMarkers(node.id)).map((m) => m.afterIndex)).toEqual([2, 4])
  })

  it('Codex: the same, through the accumulator it always had', async () => {
    const meta = JSON.stringify({
      timestamp: iso(T0),
      type: 'session_meta',
      payload: { session_id: 'r1', timestamp: iso(T0), cwd: '/work' }
    })
    const turn = (n: number): string[] => [
      JSON.stringify({ timestamp: iso(T0 + n * 1000), type: 'event_msg', payload: { type: 'user_message', message: `ask ${n}` } }),
      JSON.stringify({
        timestamp: iso(T0 + n * 1000 + 500),
        type: 'event_msg',
        payload: { type: 'agent_message', message: `re ${n}`, phase: 'final_answer' }
      })
    ]
    const { file, reader } = bed('codex', [meta, ...turn(1), ...turn(2)])
    expect((await reader.documentOf(file, 'codex')).blocks).toHaveLength(2)
    appendFileSync(file, `${turn(3).join('\n')}\n`)
    const { value: grown, parses } = await parsesDuring(() => reader.documentOf(file, 'codex'))
    expect(parses).toBe(2)
    expect(grown.blocks).toHaveLength(3)
    expect(grown.blocks).toEqual(parseCodexTrace([meta, ...turn(1), ...turn(2), ...turn(3)]))
  })
})
