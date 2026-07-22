import { describe, expect, it } from 'vitest'
import {
  pageTraceBlocks,
  parseClaudeTrace,
  parseCodexSessionMeta,
  parseCodexTrace
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
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }
      ] }
    }),
    JSON.stringify({
      type: 'user', uuid: 'tr1', timestamp: iso(T0 + 2000),
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }
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
    expect(blocks[0].activity).toEqual(['Bash(npm test)'])
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
      payload: { type: 'function_call', name: 'shell' }
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
      id: 'p1',
      index: 1,
      prompt: 'Reply with exactly: PROBE-ONE',
      reply: 'PROBE-ONE'
    })
    expect(blocks[0].activity).toEqual(['function_call(shell)'])
    expect(blocks[1]).toMatchObject({ id: 'p2', index: 2, prompt: 'and again', reply: 'again done' })
  })

  it('parses session_meta for the binder', () => {
    const meta = parseCodexSessionMeta(codexLines()[0])
    expect(meta).toEqual({ sessionId: 'sess-1', cwd: '/work/repo', timestampMs: T0 - 5000 })
    expect(parseCodexSessionMeta('{nope')).toBeNull()
    expect(parseCodexSessionMeta(JSON.stringify({ type: 'event_msg', payload: {} }))).toBeNull()
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
