// WHAT YOU SAY WHILE THE AGENT WORKS IS PART OF THE CHAT (owner, 2026-11-05:
// prompts added mid-turn never reached the chat). Claude Code never writes those
// words as a user record: they wait in its queue (`queue-operation`) and reach
// the model as a `queued_command` attachment inside the running turn. Both
// shapes below are copied from real transcripts. The turn keeps its checkpoint;
// the chat draws the words where the agent read them.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createClaudeTraceAccumulator,
  parseClaudeTrace,
  type TraceBlock
} from '../src/shared/trace-blocks'
import { parseSessionTurns } from '../src/shared/session-turns'
import { traceBlockOf } from '../src/shared/stream-turns'
import { chatFoldOf, chatLegsOf } from '../src/renderer/src/chat-fold'
import { TranscriptRow } from '../src/renderer/src/TranscriptRow'
import { TranscriptLookContext, type TranscriptLook } from '../src/renderer/src/transcript-look'
import { withLiveTail } from '../src/renderer/src/transcript'
import { recordedTail } from '../src/renderer/src/stream/stream-pager'
import type { StreamBlock, StreamTail } from '../src/renderer/src/stream/stream-types'

const T0 = Date.parse('2026-11-05T04:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const user = (uuid: string, content: unknown, ms: number): string =>
  JSON.stringify({ type: 'user', uuid, timestamp: iso(T0 + ms), message: { role: 'user', content } })
const assistant = (uuid: string, content: unknown[], ms: number): string =>
  JSON.stringify({ type: 'assistant', uuid, timestamp: iso(T0 + ms), message: { role: 'assistant', content } })
const said = (uuid: string, text: string, ms: number): string => assistant(uuid, [{ type: 'text', text }], ms)
const call = (uuid: string, id: string, ms: number): string =>
  assistant(uuid, [{ type: 'tool_use', id, name: 'Bash', input: { command: `run ${id}` } }], ms)
const result = (uuid: string, id: string, ms: number): string =>
  user(uuid, [{ type: 'tool_result', tool_use_id: id, content: 'ok' }], ms)
const delivered = (uuid: string, prompt: unknown, origin: unknown = { kind: 'human' }, commandMode = 'prompt'): string =>
  JSON.stringify({
    type: 'attachment',
    uuid,
    isSidechain: false,
    timestamp: iso(T0),
    attachment: { type: 'queued_command', prompt, commandMode, ...(origin === null ? {} : { origin }), humanTurn: true }
  })
const queue = (operation: string, content?: string): string =>
  JSON.stringify({ type: 'queue-operation', operation, timestamp: iso(T0), ...(content === undefined ? {} : { content }) })

const NOTICE = '<task-notification>\n<status>completed</status>\n<summary>Build finished</summary>\n</task-notification>'
const PEER = '<cross-session-message from="uds:/tmp/x.sock" from-name="lane">\nyour worktree got my stash\n</cross-session-message>'

/** A turn the owner spoke into once: a step, the words, then the agent goes on. */
const spokenInto = (): string[] => [
  user('u1', 'fix the build', 0),
  assistant('a1', [{ type: 'thinking', thinking: 'Check the tests.', signature: 'x' }], 100),
  said('a2', 'Running the tests.', 200),
  call('a3', 't1', 300),
  result('r1', 't1', 400),
  queue('remove', 'also deploy it'),
  delivered('q1', 'also deploy it'),
  assistant('a4', [{ type: 'thinking', thinking: 'Deploy too.', signature: 'x' }], 500),
  said('a5', 'Will deploy after.', 600),
  call('a6', 't2', 700),
  result('r2', 't2', 800),
  said('a7', 'Built and deployed.', 900)
]

describe('words delivered inside a running turn', () => {
  const [block] = parseClaudeTrace(spokenInto())

  it('stay in the turn: the checkpoint count does not move', () => {
    const lines = spokenInto()
    expect(parseClaudeTrace(lines)).toHaveLength(1)
    expect(parseSessionTurns(lines)).toHaveLength(1)
    expect(block.prompt).toBe('fix the build')
  })

  it('are marked where the agent read them', () => {
    expect(block.added).toEqual([{ at: 'Running the tests.'.length, calls: 1, thoughts: 1, text: 'also deploy it' }])
  })

  it('leave the reply and the steps exactly as they were', () => {
    expect(block.reply).toBe('Running the tests.\n\nWill deploy after.\n\nBuilt and deployed.')
    expect(block.activity).toHaveLength(2)
    expect(block.thoughts).toHaveLength(2)
  })

  it('are absent from a turn nobody spoke into', () => {
    const [plain] = parseClaudeTrace([user('u1', 'go', 0), said('a1', 'ok', 1)])
    expect('added' in plain).toBe(false)
    expect('queued' in plain).toBe(false)
  })

  it('keep the words of a prompt that carried a picture, never its bytes', () => {
    const [b] = parseClaudeTrace([
      user('u1', 'go', 0),
      delivered('q1', [
        { type: 'text', text: '[Image #2] take the frame off' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }
      ])
    ])
    expect(b.added?.map((a) => a.text)).toEqual(['[Image #2] take the frame off'])
  })

  it('count a transcript older than the origin field as the owner', () => {
    const [b] = parseClaudeTrace([user('u1', 'go', 0), delivered('q1', 'older shape', null)])
    expect(b.added?.map((a) => a.text)).toEqual(['older shape'])
  })

  it('are never a background task, a peer, or anything but a prompt', () => {
    const [b] = parseClaudeTrace([
      user('u1', 'go', 0),
      delivered('q1', NOTICE, { kind: 'task-notification' }, 'task-notification'),
      delivered('q2', NOTICE, null, 'task-notification'),
      delivered('q3', PEER, { kind: 'peer' }),
      delivered('q4', PEER, null),
      delivered('q5', '   ')
    ])
    expect('added' in b).toBe(false)
  })

  it('wait for a turn: words before the first prompt open nothing', () => {
    expect(parseClaudeTrace([delivered('q1', 'too early'), queue('enqueue', 'too early')])).toHaveLength(0)
  })
})

describe('words still waiting in the queue', () => {
  const opened = [user('u1', 'go', 0), call('a1', 't1', 100)]

  it('show the moment they are sent, before the agent has read them', () => {
    const [b] = parseClaudeTrace([...opened, queue('enqueue', 'and the docs')])
    expect(b.queued).toEqual(['and the docs'])
    expect('added' in b).toBe(false)
  })

  it('move into the turn when the agent reads them', () => {
    const [b] = parseClaudeTrace([...opened, queue('enqueue', 'and the docs'), queue('remove', 'and the docs'), delivered('q1', 'and the docs')])
    expect('queued' in b).toBe(false)
    expect(b.added?.map((a) => a.text)).toEqual(['and the docs'])
  })

  it('go when the owner takes them back into the input', () => {
    const [b] = parseClaudeTrace([...opened, queue('enqueue', 'one'), queue('enqueue', 'two'), queue('popAll', 'one'), queue('popAll', 'two')])
    expect('queued' in b).toBe(false)
    expect('added' in b).toBe(false)
  })

  it('become the next turn when the agent finishes first, and show once', () => {
    const blocks = parseClaudeTrace([...opened, queue('enqueue', 'next thing'), queue('dequeue'), user('u2', 'next thing', 200)])
    expect(blocks.map((b) => b.prompt)).toEqual(['go', 'next thing'])
    expect(blocks.some((b) => 'queued' in b)).toBe(false)
  })

  it('never outlive their turn, whatever the queue said', () => {
    const blocks = parseClaudeTrace([...opened, queue('enqueue', 'lost in a crash'), user('u2', 'new start', 200)])
    expect(blocks.some((b) => 'queued' in b)).toBe(false)
  })

  it('hide what the harness queued, and its dequeue takes its own place in line', () => {
    const [b] = parseClaudeTrace([...opened, queue('enqueue', NOTICE), queue('enqueue', PEER), queue('enqueue', 'mine'), queue('dequeue'), queue('dequeue')])
    expect(b.queued).toEqual(['mine'])
  })

  it('keep a prompt with no words in line without drawing it', () => {
    const [b] = parseClaudeTrace([...opened, queue('enqueue'), queue('enqueue', 'mine'), queue('dequeue')])
    expect(b.queued).toEqual(['mine'])
  })

  it('replace the list rather than grow it: a shallow copy still sees the change', () => {
    const accumulator = createClaudeTraceAccumulator()
    accumulator.feed([...opened, queue('enqueue', 'one')])
    const before = accumulator.blocks()[0].queued
    accumulator.feed([queue('enqueue', 'two')])
    expect(before).toEqual(['one'])
    expect(accumulator.blocks()[0].queued).toEqual(['one', 'two'])
  })
})

describe('the resumable parser agrees with the whole file', () => {
  it('at every split point', () => {
    const lines = [...spokenInto(), queue('enqueue', 'tail words')]
    const whole = parseClaudeTrace(lines)
    for (let cut = 0; cut <= lines.length; cut++) {
      const accumulator = createClaudeTraceAccumulator()
      accumulator.feed(lines.slice(0, cut))
      accumulator.feed(lines.slice(cut))
      expect(accumulator.blocks()).toEqual(whole)
    }
  })
})

describe('the stream carries them', () => {
  it('through the /trace projection', () => {
    const [block] = parseClaudeTrace([...spokenInto(), queue('enqueue', 'tail words')])
    const projected = traceBlockOf({ ...block, ordinal: 1, compacted: false, file: 'f', sessionId: 's' })
    expect(projected.added).toEqual(block.added)
    expect(projected.queued).toEqual(['tail words'])
  })
})

describe('the chat splits a turn at the words spoken into it', () => {
  const [block] = parseClaudeTrace(spokenInto())
  const legs = chatLegsOf(block)

  it('a turn nobody spoke into is one leg, the fold it always was', () => {
    const plain = { reply: 'hello', activity: [] }
    expect(chatLegsOf(plain)).toEqual([{ words: null, fold: chatFoldOf(plain) }])
  })

  it('each leg holds only what happened on its side of the words', () => {
    expect(legs.map((l) => l.words)).toEqual([null, 'also deploy it'])
    expect(legs[0].fold).toMatchObject({ thoughts: 1, tools: 1, answer: '' })
    expect(legs[1].fold).toMatchObject({ thoughts: 1, tools: 1, answer: 'Built and deployed.' })
  })

  it('steps keep their order against the words after the split', () => {
    expect(legs[0].fold.steps.map((s) => s.kind)).toEqual(['thought', 'said', 'tool'])
    expect(legs[1].fold.steps.map((s) => s.kind)).toEqual(['thought', 'said', 'tool'])
    expect(legs[1].fold.steps[1]).toEqual({ kind: 'said', text: 'Will deploy after.' })
  })

  it('what the agent said just before the words stays in view', () => {
    const [b] = parseClaudeTrace([user('u1', 'go', 0), said('a1', 'Half way there.', 100), delivered('q1', 'stop'), said('a2', 'Stopped.', 200)])
    expect(chatLegsOf(b).map((l) => [l.words, l.fold.answer])).toEqual([
      [null, 'Half way there.'],
      ['stop', 'Stopped.']
    ])
  })

  it('two sayings with nothing between them leave an empty leg, not a lost one', () => {
    const [b] = parseClaudeTrace([user('u1', 'go', 0), delivered('q1', 'one'), delivered('q2', 'two'), said('a1', 'Both done.', 100)])
    expect(chatLegsOf(b).map((l) => [l.words, l.fold.answer])).toEqual([
      [null, ''],
      ['one', ''],
      ['two', 'Both done.']
    ])
  })
})

describe('the row draws them', () => {
  const [block] = parseClaudeTrace(spokenInto())
  const render = (b: TraceBlock, look: TranscriptLook = 'chat', last = true, translated: { index: number; prompt: string; reply: string } | null = null): string =>
    renderToStaticMarkup(
      <TranscriptLookContext.Provider value={look}>
        <TranscriptRow id={1} block={b} active={false} placeholderHeight={undefined} titleMode="precise" translated={translated} last={last} />
      </TranscriptLookContext.Provider>
    )

  it('as your bubble, in view while the steps around it stay folded', () => {
    const html = render(block)
    expect(html.match(/ctx-block-prompt/g)).toHaveLength(2)
    expect(html).toContain('also deploy it')
    expect(html.match(/ctx-process-toggle/g)).toHaveLength(2)
    expect(html).not.toContain('ctx-block-tool')
    expect(html.indexOf('also deploy it')).toBeLessThan(html.indexOf('Built and deployed.'))
  })

  it('in the log, between the steps it fell between', () => {
    const html = render(block, 'log')
    expect(html.indexOf('run t1')).toBeLessThan(html.indexOf('also deploy it'))
    expect(html.indexOf('also deploy it')).toBeLessThan(html.indexOf('run t2'))
  })

  it('a translation stays the closing answer, drawn once', () => {
    const html = render(block, 'chat', true, { index: 1, prompt: 'Arregla', reply: 'Construido y desplegado.' })
    expect(html.match(/Construido y desplegado/g)).toHaveLength(1)
    expect(html).not.toContain('Built and deployed.')
    expect(html).toContain('also deploy it')
  })

  it('queued words sit under the turn, marked as not read yet', () => {
    const html = render({ ...block, queued: ['and the docs'] })
    expect(html).toContain('ctx-block-queued')
    expect(html).toContain('and the docs')
    expect(html.indexOf('Built and deployed.')).toBeLessThan(html.indexOf('and the docs'))
  })

  it('only the newest turn can be waiting: a rotated file leaves none behind', () => {
    expect(render({ ...block, queued: ['stale'] }, 'chat', false)).not.toContain('stale')
  })
})

// THE SECOND HALF OF THE SAME REPORT. The drawer fetches a window when `total`
// grows, and a word sent mid-turn does not grow it: the open turn's row sat as it
// was loaded until the next prompt, with its whole new self already on the
// client in the live tail. Without this the parser's fix never reaches the screen.
describe('the open chat follows the turn it is showing', () => {
  const stream = (block: TraceBlock, file = 'a.jsonl'): StreamBlock => ({ ...block, ordinal: block.index, compacted: false, file, sessionId: 's' })
  const tailOf = (block: StreamBlock): StreamTail => ({ block, final: false, ordinal: block.ordinal, total: block.ordinal })
  const [older] = parseClaudeTrace([user('u1', 'fix the build', 0), said('a1', 'Running the tests.', 100)])
  const [newer] = parseClaudeTrace([...spokenInto(), queue('enqueue', 'tail words')])
  const other: TraceBlock = { ...older, id: 'u0', index: 1 }

  it('swaps the row the tail is, and only that row', () => {
    const shown = withLiveTail([other, { ...older, index: 2 }], { ...newer, index: 2 })
    expect(shown[0]).toBe(other)
    expect(shown[1].added?.map((a) => a.text)).toEqual(['also deploy it'])
    expect(shown[1].queued).toEqual(['tail words'])
  })

  it('leaves the list alone when the tail is not loaded: the window is the pager\'s, not this', () => {
    const loaded = [other]
    expect(withLiveTail(loaded, newer)).toBe(loaded)
    expect(withLiveTail(loaded, null)).toBe(loaded)
  })

  it('takes the tail in the row\'s coordinates', () => {
    expect(recordedTail(tailOf({ ...stream(newer), ordinal: 7 }))?.index).toBe(7)
  })

  it('never takes a tail made from a turn record: a reply with no steps is poorer than the row', () => {
    expect(recordedTail(tailOf(stream(newer, '')))).toBeNull()
    expect(recordedTail(null)).toBeNull()
    expect(recordedTail({ block: null, final: false, ordinal: null, total: 0 })).toBeNull()
  })

  it('is wired from the stream to the rows, with no fetch of its own', () => {
    const read = (file: string): string => readFileSync(join(process.cwd(), 'src/renderer/src', file), 'utf8')
    expect(read('TerminalOverlay.tsx')).toMatch(/liveTail=\{liveTail\}/)
    expect(read('TerminalOverlay.tsx')).toMatch(/recordedTail\(stream\.tail\)/)
    expect(read('TranscriptView.tsx')).toMatch(/setBlocks\(\(prev\) => withLiveTail\(prev, liveTail\)\)/)
  })
})
