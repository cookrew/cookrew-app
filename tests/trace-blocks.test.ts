import { describe, expect, it } from 'vitest'
import {
  compactMarkersOf,
  pageTraceBlocks,
  parseClaudeTrace,
  parseCodexSessionMeta,
  parseCodexTrace,
  parsePiTrace,
  traceIndexOf
} from '../src/shared/trace-blocks'

const T0 = Date.parse('2026-07-22T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

function claudeLines(): string[] {
  return [
    JSON.stringify({ type: 'mode', sessionId: 's' }),
    JSON.stringify({
      type: 'user', uuid: 'u1', timestamp: iso(T0),
      message: { role: 'user', content: 'first ask\nwith a second line' }
    }),
    JSON.stringify({
      type: 'assistant', uuid: 'a1', timestamp: iso(T0 + 1000),
      message: { role: 'assistant', content: [
        { type: 'text', text: 'working on it' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }
      ] }
    }),
    JSON.stringify({
      type: 'user', uuid: 'tr1', timestamp: iso(T0 + 2000),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '160 tests passed' }]
      }
    }),
    JSON.stringify({
      type: 'assistant', uuid: 'a2', timestamp: iso(T0 + 3000),
      message: { role: 'assistant', content: [{ type: 'text', text: 'all green' }] }
    }),
    JSON.stringify({
      type: 'user', uuid: 'u2', timestamp: iso(T0 + 9000),
      message: { role: 'user', content: 'second ask' }
    }),
    JSON.stringify({
      type: 'assistant', uuid: 'a3', timestamp: iso(T0 + 9500),
      message: { role: 'assistant', content: [{ type: 'text', text: 'done two' }] }
    })
  ]
}

describe('parseClaudeTrace (full-trace blocks)', () => {
  it('builds uuid-keyed blocks with exact prompts, replies and tool activity', () => {
    const blocks = parseClaudeTrace(claudeLines())
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({
      id: 'u1',
      index: 1,
      prompt: 'first ask\nwith a second line',
      reply: 'working on it\nall green'
    })
    expect(blocks[0].activity).toEqual([
      { tool: 'Bash', args: 'npm test', result: '160 tests passed' }
    ])
    expect(blocks[0].startedAt).toBe(T0)
    expect(blocks[0].endedAt).toBe(T0 + 3000)
    expect(blocks[1]).toMatchObject({ id: 'u2', index: 2, reply: 'done two' })
  })

  it('skips noise prompts and tolerates corrupt lines', () => {
    const lines = [
      '{corrupt',
      JSON.stringify({
        type: 'user', uuid: 'n1', timestamp: iso(T0),
        message: { content: '<command-name>/clear</command-name>' }
      }),
      ...claudeLines()
    ]
    expect(parseClaudeTrace(lines)).toHaveLength(2)
  })
})

function codexLines(): string[] {
  return [
    JSON.stringify({
      timestamp: iso(T0), type: 'session_meta',
      payload: { session_id: 'sess-1', timestamp: iso(T0 - 5000), cwd: '/work/repo' }
    }),
    JSON.stringify({
      timestamp: iso(T0 + 100), type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'perms' }] }
    }),
    JSON.stringify({
      timestamp: iso(T0 + 200), type: 'event_msg',
      payload: { type: 'user_message', message: 'Reply with exactly: PROBE-ONE' }
    }),
    JSON.stringify({
      timestamp: iso(T0 + 300), type: 'response_item',
      payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"cmd":"ls"}' }
    }),
    JSON.stringify({
      timestamp: iso(T0 + 400), type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c1', output: 'README.md\nsrc' }
    }),
    JSON.stringify({
      timestamp: iso(T0 + 900), type: 'event_msg',
      payload: { type: 'agent_message', message: 'PROBE-ONE', phase: 'final_answer' }
    }),
    JSON.stringify({
      timestamp: iso(T0 + 5000), type: 'event_msg',
      payload: { type: 'user_message', message: 'and again' }
    }),
    JSON.stringify({
      timestamp: iso(T0 + 6000), type: 'event_msg',
      payload: { type: 'agent_message', message: 'again done', phase: 'final_answer' }
    })
  ]
}

describe('parseCodexTrace (rollout blocks)', () => {
  it('builds position-keyed blocks from user/agent messages with activity', () => {
    const blocks = parseCodexTrace(codexLines())
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({
      id: 'sess-1:p1',
      index: 1,
      prompt: 'Reply with exactly: PROBE-ONE',
      reply: 'PROBE-ONE'
    })
    expect(blocks[0].activity).toEqual([
      { tool: 'shell', args: '{"cmd":"ls"}', result: 'README.md\nsrc' }
    ])
    expect(blocks[1]).toMatchObject({ id: 'sess-1:p2', index: 2, prompt: 'and again', reply: 'again done' })
  })

  it('parses session_meta for the binder', () => {
    const meta = parseCodexSessionMeta(codexLines()[0])
    expect(meta).toEqual({ sessionId: 'sess-1', cwd: '/work/repo', timestampMs: T0 - 5000 })
    expect(parseCodexSessionMeta('{nope')).toBeNull()
    expect(parseCodexSessionMeta(JSON.stringify({ type: 'event_msg', payload: {} }))).toBeNull()
  })
})

describe('parsePiTrace (active session-tree branch)', () => {
  it('joins assistant text, matches tool results, and excludes an abandoned sibling branch', () => {
    const line = (value: unknown): string => JSON.stringify(value)
    const lines = [
      line({ type: 'session', version: 3, id: 'session-id', cwd: '/work/repo' }),
      line({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-03T00:00:01Z', message: { role: 'user', content: 'Inspect it' } }),
      line({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-08-03T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'src/a.ts' } }] } }),
      line({ type: 'message', id: 'r1', parentId: 'a1', timestamp: '2026-08-03T00:00:03Z', message: { role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', content: [{ type: 'text', text: 'file body' }] } }),
      line({ type: 'message', id: 'a2', parentId: 'r1', timestamp: '2026-08-03T00:00:04Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Found it.' }] } }),
      line({ type: 'message', id: 'dead-u', parentId: 'a2', timestamp: '2026-08-03T00:00:05Z', message: { role: 'user', content: 'Abandoned branch' } }),
      line({ type: 'message', id: 'dead-a', parentId: 'dead-u', timestamp: '2026-08-03T00:00:06Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Old answer' }] } }),
      line({ type: 'message', id: 'u2', parentId: 'a2', timestamp: '2026-08-03T00:00:07Z', message: { role: 'user', content: [{ type: 'text', text: 'Fix it' }] } }),
      line({ type: 'message', id: 'a3', parentId: 'u2', timestamp: '2026-08-03T00:00:08Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } })
    ]

    expect(parsePiTrace(lines)).toEqual([
      {
        id: 'u1', index: 1, prompt: 'Inspect it', reply: 'Checking.\nFound it.',
        activity: [{ tool: 'read', args: 'src/a.ts', result: 'file body' }],
        startedAt: Date.parse('2026-08-03T00:00:01Z'),
        endedAt: Date.parse('2026-08-03T00:00:04Z')
      },
      {
        id: 'u2', index: 2, prompt: 'Fix it', reply: 'Done.', activity: [],
        startedAt: Date.parse('2026-08-03T00:00:07Z'),
        endedAt: Date.parse('2026-08-03T00:00:08Z')
      }
    ])
  })
})

describe('pageTraceBlocks (identity-keyed windows, review BLOCK 2)', () => {
  const blocks = Array.from({ length: 9 }, (_, i) => ({
    id: `u${i + 1}`, index: i + 1, prompt: `p${i + 1}`, reply: '', activity: [],
    startedAt: i, endedAt: i
  }))

  it('defaults to the tail window', () => {
    const page = pageTraceBlocks(blocks, { limit: 3 })
    expect(page.blocks.map((b) => b.index)).toEqual([7, 8, 9])
    expect(page.total).toBe(9)
  })

  it('beforeIndex serves the nearest OLDER blocks (scroll-up)', () => {
    const page = pageTraceBlocks(blocks, { beforeIndex: 7, limit: 3 })
    expect(page.blocks.map((b) => b.index)).toEqual([4, 5, 6])
    // Short at the top, never shifted.
    expect(pageTraceBlocks(blocks, { beforeIndex: 2, limit: 3 }).blocks.map((b) => b.index)).toEqual([1])
  })

  it('afterIndex serves the nearest NEWER blocks', () => {
    expect(pageTraceBlocks(blocks, { afterIndex: 7, limit: 3 }).blocks.map((b) => b.index)).toEqual([8, 9])
  })

  it('aroundIndex centers on the checkpoint, tail fallback when unknown', () => {
    expect(pageTraceBlocks(blocks, { aroundIndex: 5, limit: 3 }).blocks.map((b) => b.index)).toEqual([4, 5, 6])
    expect(pageTraceBlocks(blocks, { aroundIndex: 77, limit: 2 }).blocks.map((b) => b.index)).toEqual([8, 9])
  })

  it('identity survives non-contiguous indexes (capped histories)', () => {
    const gappy = [5, 6, 9, 12].map((n) => ({ ...blocks[0], id: `u${n}`, index: n }))
    expect(pageTraceBlocks(gappy, { beforeIndex: 9, limit: 2 }).blocks.map((b) => b.index)).toEqual([5, 6])
  })
})


describe('claude tool_use args summary (bare-parens bug)', () => {
  const entry = (blocks: unknown[]): string[] => [
    JSON.stringify({
      type: 'user', uuid: 'u1', timestamp: iso(T0),
      message: { role: 'user', content: 'ask' }
    }),
    JSON.stringify({
      type: 'assistant', timestamp: iso(T0 + 1000),
      message: { role: 'assistant', content: blocks }
    })
  ]

  it('prefers input.description as the human args summary (verified shape)', () => {
    const blocks = parseClaudeTrace(
      entry([
        {
          type: 'tool_use', id: 'tu1', name: 'Bash',
          input: { command: 'npm test 2>&1 | tail -3', description: 'Run the test suite' }
        }
      ])
    )
    expect(blocks[0].activity).toEqual([
      { tool: 'Bash', args: 'Run the test suite', result: '' }
    ])
  })

  it('falls back to the first string value, truncated ~80 chars', () => {
    const long = 'x'.repeat(200)
    const blocks = parseClaudeTrace(
      entry([{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: long } }])
    )
    expect(blocks[0].activity[0].tool).toBe('Read')
    expect(blocks[0].activity[0].args.length).toBeLessThanOrEqual(80)
    expect(blocks[0].activity[0].args.startsWith('xxx')).toBe(true)
  })

  it('SKIPS empty-name blocks — never a bare () line', () => {
    const blocks = parseClaudeTrace(
      entry([
        { type: 'tool_use', id: 'tu1', name: '', input: {} },
        { type: 'tool_use', id: 'tu2', input: { q: 'no name at all' } },
        { type: 'tool_use', id: 'tu3', name: 'Grep', input: { pattern: 'foo' } }
      ])
    )
    expect(blocks[0].activity).toEqual([{ tool: 'Grep', args: 'foo', result: '' }])
  })

  it('handles non-object and empty inputs without noise', () => {
    const blocks = parseClaudeTrace(
      entry([{ type: 'tool_use', id: 'tu1', name: 'NoteRead', input: {} }])
    )
    expect(blocks[0].activity).toEqual([{ tool: 'NoteRead', args: '', result: '' }])
  })
})

describe('traceIndexOf (cheap identity+title listing for the fan)', () => {
  const block = (index: number, prompt: string): Parameters<typeof traceIndexOf>[0][0] => ({
    id: `u${index}`, index, prompt, reply: '', activity: [], startedAt: 0, endedAt: 0
  })

  it('lists every identity with a first-line prompt snippet', () => {
    const entries = traceIndexOf([
      block(1, 'fix the phone layout\nwith details below'),
      block(2, '   \n  second ask after blank line')
    ])
    expect(entries).toEqual([
      { index: 1, title: 'fix the phone layout' },
      { index: 2, title: 'second ask after blank line' }
    ])
  })

  it('caps long titles and labels empty prompts', () => {
    const entries = traceIndexOf([block(1, 'y'.repeat(200)), block(2, '   ')])
    expect(entries[0].title.length).toBeLessThanOrEqual(80)
    expect(entries[1].title).toBe('(empty prompt)')
  })
})

describe('compactMarkersOf (◆ rail markers from compact_boundary entries)', () => {
  const prompt = (uuid: string, text: string, ms: number): string =>
    JSON.stringify({ type: 'user', uuid, timestamp: iso(ms), message: { role: 'user', content: text } })
  const boundary = (pre: number, post: number): string =>
    JSON.stringify({
      type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted',
      compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: post }
    })

  it('positions a boundary AFTER the checkpoint ordinal it follows (assigner-aligned)', () => {
    const lines = [
      prompt('u1', 'first', T0),
      prompt('u2', 'second', T0 + 1000),
      boundary(999600, 11200),
      prompt('u3', 'third', T0 + 2000)
    ]
    expect(compactMarkersOf(lines)).toEqual([
      { kind: 'compact', afterIndex: 2, preTokens: 999600, postTokens: 11200 }
    ])
  })

  it('a boundary before any checkpoint gets afterIndex 0; missing metadata is omitted', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
      prompt('u1', 'first', T0)
    ]
    expect(compactMarkersOf(lines)).toEqual([{ kind: 'compact', afterIndex: 0 }])
  })

  it('sibling-collapse prompts do not shift the boundary ordinal', () => {
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: 'p', timestamp: iso(T0), message: { role: 'user', content: 'same submission' } }),
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'p', timestamp: iso(T0 + 100), message: { role: 'user', content: 'same submission' } }),
      boundary(10, 1)
    ]
    expect(compactMarkersOf(lines)).toEqual([{ kind: 'compact', afterIndex: 1, preTokens: 10, postTokens: 1 }])
  })
})
