// THE CHAT FOLDS THE AGENT'S STEPS AND SHOWS ITS ANSWER (owner, 2026-11-01:
// "fold the thinking and the tool calls"). The parser marks where in the reply
// each tool call and thought fell; the row shows one closed line for them and
// the words after the last step. The log look prints every step, as the
// terminal does.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseClaudeTrace, parsePiTrace, replyAt, type TraceBlock } from '../src/shared/trace-blocks'
import { traceBlockOf } from '../src/shared/stream-turns'
import { chatFoldLabel, chatFoldOf, latestStepLine } from '../src/renderer/src/chat-fold'
import { TranscriptRow } from '../src/renderer/src/TranscriptRow'
import { TranscriptLookContext, type TranscriptLook } from '../src/renderer/src/transcript-look'

const T0 = Date.parse('2026-11-01T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const user = (uuid: string, content: unknown, ms: number): string =>
  JSON.stringify({ type: 'user', uuid, timestamp: iso(T0 + ms), message: { role: 'user', content } })
const assistant = (uuid: string, content: unknown[], ms: number): string =>
  JSON.stringify({ type: 'assistant', uuid, timestamp: iso(T0 + ms), message: { role: 'assistant', content } })

/** A turn as Claude Code writes it: thinking, a word, a call, its result, more thinking, a second call, the answer. */
const turn = (): string[] => [
  user('u1', 'why is the build red?', 0),
  assistant('a1', [{ type: 'thinking', thinking: 'The build broke after the merge; check the test output first.', signature: 'x' }], 100),
  assistant('a2', [{ type: 'text', text: 'Let me run the tests.' }], 200),
  assistant('a3', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], 300),
  user('r1', [{ type: 'tool_result', tool_use_id: 't1', content: '1 failed' }], 400),
  assistant('a4', [{ type: 'thinking', thinking: '', signature: 'redacted' }], 500),
  assistant('a5', [{ type: 'thinking', thinking: 'One failure in the parser.', signature: 'x' }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'src/parse.ts' } }], 600),
  user('r2', [{ type: 'tool_result', tool_use_id: 't2', content: 'export function parse' }], 700),
  assistant('a6', [{ type: 'text', text: 'The parser drops **empty** lines.\n\nFixed in `parse.ts`.' }], 800)
]

describe('the parser marks each step in the reply', () => {
  const [block] = parseClaudeTrace(turn())

  it('keeps the reply whole: every message the agent sent', () => {
    expect(block.reply).toBe('Let me run the tests.\n\nThe parser drops **empty** lines.\n\nFixed in `parse.ts`.')
  })

  it('places each call after the words that came before it', () => {
    expect(block.activity.map((c) => [c.tool, c.at])).toEqual([
      ['Bash', 'Let me run the tests.'.length],
      ['Read', 'Let me run the tests.'.length]
    ])
  })

  it('keeps the thinking that has words, in order, and none that is redacted', () => {
    expect(block.thoughts).toEqual([
      { at: 0, calls: 0, text: 'The build broke after the merge; check the test output first.' },
      { at: 'Let me run the tests.'.length, calls: 1, text: 'One failure in the parser.' }
    ])
  })

  it('caps a long thought', () => {
    const [b] = parseClaudeTrace([user('u1', 'go', 0), assistant('a1', [{ type: 'thinking', thinking: 'x'.repeat(5000) }], 1)])
    expect(b.thoughts?.[0].text.length).toBe(600)
  })

  it('leaves `thoughts` off a block without thinking', () => {
    const [b] = parseClaudeTrace([user('u1', 'go', 0), assistant('a1', [{ type: 'text', text: 'ok' }], 1)])
    expect('thoughts' in b).toBe(false)
  })

  it('a step mid-message falls after the words before it in that message', () => {
    const [b] = parseClaudeTrace([
      user('u1', 'go', 0),
      assistant('a0', [{ type: 'text', text: 'first' }], 1),
      assistant('a1', [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }, { type: 'text', text: 'after' }], 2)
    ])
    expect(b.reply).toBe('first\n\none\ntwo\nafter')
    expect(b.reply.slice(0, b.activity[0].at)).toBe('first\n\none\ntwo')
  })

  it('pi calls are marked too', () => {
    const [b] = parsePiTrace([
      JSON.stringify({ type: 'message', id: 'm1', timestamp: iso(T0), message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
      JSON.stringify({ type: 'message', id: 'm2', parentId: 'm1', timestamp: iso(T0 + 1), message: { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a' } }] } })
    ])
    expect(b.activity[0].at).toBe('Looking.'.length)
  })

  it('the stream projection carries the thoughts through', () => {
    const projected = traceBlockOf({ ...block, ordinal: 1 } as TraceBlock & { ordinal: number } as never)
    expect(projected.thoughts).toEqual(block.thoughts)
  })

  it('replyAt joins pending texts as the parser does', () => {
    expect(replyAt('', [])).toBe(0)
    expect(replyAt('abc', [])).toBe(3)
    expect(replyAt('', ['ab', 'c'])).toBe(4)
    expect(replyAt('abc', ['de'])).toBe(7)
  })
})

describe('chatFoldOf', () => {
  it('folds the thinking, the words between steps and the calls; the answer is what follows the last step', () => {
    const [block] = parseClaudeTrace(turn())
    const fold = chatFoldOf(block)
    expect(fold.steps.map((s) => s.kind)).toEqual(['thought', 'said', 'tool', 'thought', 'tool'])
    expect(fold.steps[1]).toEqual({ kind: 'said', text: 'Let me run the tests.' })
    expect(fold.answer).toBe('The parser drops **empty** lines.\n\nFixed in `parse.ts`.')
    expect(fold).toMatchObject({ thoughts: 2, tools: 2 })
  })

  it('a turn that took no step is all answer', () => {
    expect(chatFoldOf({ reply: 'hello', activity: [] })).toEqual({ steps: [], answer: 'hello', thoughts: 0, tools: 0 })
  })

  it('a call without a mark (codex: the reply is its last message) comes before the whole reply', () => {
    const fold = chatFoldOf({ reply: 'done', activity: [{ tool: 'shell', args: 'ls', result: '' }] })
    expect(fold.steps.map((s) => s.kind)).toEqual(['tool'])
    expect(fold.answer).toBe('done')
  })

  it('a turn still working has no answer yet, and the closed line names its newest step', () => {
    const fold = chatFoldOf({ reply: 'Checking.', activity: [{ tool: 'Bash', args: 'npm test', result: '', at: 9 }] })
    expect(fold.answer).toBe('')
    expect(latestStepLine(fold.steps)).toBe('Bash · npm test')
  })

  it('a mark past a cut reply stays inside it', () => {
    const fold = chatFoldOf({ reply: 'short', activity: [{ tool: 'Bash', args: '', result: '', at: 999 }] })
    expect(fold.steps.map((s) => s.kind)).toEqual(['said', 'tool'])
    expect(fold.answer).toBe('')
  })

  it('labels the fold by what it holds', () => {
    expect(chatFoldLabel({ thoughts: 2, tools: 12 })).toBe('Thought · 12 tool calls')
    expect(chatFoldLabel({ thoughts: 0, tools: 1 })).toBe('1 tool call')
    expect(chatFoldLabel({ thoughts: 3, tools: 0 })).toBe('Thought')
  })
})

describe('the row', () => {
  const [block] = parseClaudeTrace(turn())
  const render = (look: TranscriptLook): string =>
    renderToStaticMarkup(
      <TranscriptLookContext.Provider value={look}>
        <TranscriptRow id={1} block={block} active={false} placeholderHeight={undefined} titleMode="precise" translated={null} />
      </TranscriptLookContext.Provider>
    )

  it('in the chat: one closed line, the answer under it, no step drawn', () => {
    const html = render('chat')
    expect(html).toContain('ctx-process-toggle')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Thought · 2 tool calls')
    expect(html).not.toContain('ctx-block-tool')
    expect(html).not.toContain('One failure in the parser')
    expect(html).not.toContain('Let me run the tests')
    expect(html).toContain('<strong>empty</strong>')
  })

  it('in the log: every step printed, in order', () => {
    const html = render('log')
    expect(html).toContain('aria-expanded="true"')
    expect(html.match(/ctx-block-tool/g)).toHaveLength(2)
    expect(html.indexOf('Let me run the tests')).toBeLessThan(html.indexOf('npm test'))
    expect(html.indexOf('npm test')).toBeLessThan(html.indexOf('src/parse.ts'))
    expect(html.indexOf('src/parse.ts')).toBeLessThan(html.indexOf('<strong>empty</strong>'))
  })

  it('a reply with no steps has no fold line', () => {
    const html = renderToStaticMarkup(
      <TranscriptRow id={2} block={{ ...block, reply: 'hi', activity: [], thoughts: undefined }} active={false} placeholderHeight={undefined} titleMode="precise" translated={null} />
    )
    expect(html).not.toContain('ctx-process-toggle')
    expect(html).toContain('hi')
  })

  it('a turn with only thinking so far still draws the agent bubble', () => {
    const html = renderToStaticMarkup(
      <TranscriptRow id={3} block={{ ...block, reply: '', activity: [], thoughts: [{ at: 0, calls: 0, text: 'hmm' }] }} active={false} placeholderHeight={undefined} titleMode="precise" translated={null} />
    )
    expect(html).toContain('ctx-chat-bubble')
    expect(html).toContain('ctx-process-now')
  })
})
