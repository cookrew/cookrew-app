// THE CARD READS ITS LATEST REPLY (owner, 2026-11-04: "the full message of the
// latest reply is not shown"). The card said one cut line, and on a card with
// no live mirror it was the turn's FIRST sentence. It now says what the agent
// said last, wrapped into the room the card has, and a tap on the words
// unfolds the rest in place. The tap itself is driven in the headless QA: this
// suite has no DOM.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CardBody, wordsOf } from '../src/renderer/src/zoom/CardBody'
import { streamBlockViewModel } from '../src/renderer/src/stream/stream-view'
import type { AgentView } from '../src/renderer/src/zoom/zoom-model'
import type { TurnViewModel } from '../src/renderer/src/turn-view-model'

const turn = (over: Partial<TurnViewModel> = {}): TurnViewModel => ({
  title: 'Fix the bar',
  ask: 'fix it',
  tools: [],
  latest: { text: 'Done.', tone: 'done', full: 'Done.\n\n**Two** things changed:\n\n- the bar\n- the card' },
  pendingInput: null,
  tail: null,
  ...over
})
const agent = (t: TurnViewModel | null): AgentView => ({ id: 'a1', name: 'Tinker', line: 'push feat/x', turn: t }) as AgentView
const body = (t: TurnViewModel | null, roomy = false, sent: string | null = null): string =>
  renderToStaticMarkup(<CardBody agent={agent(t)} sent={sent} roomy={roomy} />)

describe('the card says what the agent said last', () => {
  it('a card with no mirror shows the closing message, not the turn\'s opening line', () => {
    const block = {
      id: 'b1',
      index: 1,
      prompt: 'ask',
      reply: 'Let me look at the code.\n\nFixed. Both doors open.',
      activity: [{ tool: 'Read', args: 'a.ts', result: '', at: 'Let me look at the code.'.length }],
      startedAt: 0,
      endedAt: 1
    }
    const model = streamBlockViewModel(block as never)
    expect(model?.latest).toEqual({ text: 'Fixed. Both doors open.', tone: 'done' })
  })

  it('the board\'s preview reads the same closing message', () => {
    const tails = readFileSync('src/renderer/src/stream/use-stream-tails.ts', 'utf8')
    expect(tails).toContain('reply: closingMessage(tail.block)')
  })
})

describe('the card reads the whole of it', () => {
  it('draws the whole reply, as markdown, not its first line', () => {
    const html = body(turn())
    expect(html).toContain('<strong>Two</strong> things changed:')
    expect(html).toContain('<li>the card</li>')
    expect(html).toContain('ag-now ag-full done')
  })

  it('a one-line reply wraps too: a long paragraph has no second line to fall back on', () => {
    const html = body(turn({ latest: { text: 'One long paragraph.', tone: 'done' } }))
    expect(html).toContain('ag-now ag-full done')
    expect(html).toContain('One long paragraph.')
  })

  it('a live status stays one line', () => {
    const html = body(turn({ latest: { text: 'Brewing… (6m 5s)', tone: 'working' } }))
    expect(html).toContain('ag-now working')
    expect(html).not.toContain('ag-full')
  })

  it('a question reads whole, its dot still on it', () => {
    const html = body(turn({ latest: { text: 'Allow?', tone: 'waiting', full: 'Allow?\n\n1. Yes' } }))
    expect(html).toContain('ag-now ag-full waiting')
    expect(html).toContain('ag-dot')
    expect(html).toContain('<li>Yes</li>')
  })

  it('the words take the empty strip when the card has no thumbnails', () => {
    expect(body(turn(), true)).toContain('zv-body roomy')
    expect(body(turn(), false)).not.toContain('roomy')
  })

  it('offers nothing to unfold until the words are measured as cut', () => {
    expect(body(turn())).not.toContain('zv-more')
  })
})

describe('what a fold belongs to', () => {
  it('is the words it was opened on: a new message folds the card again', () => {
    const a = wordsOf(agent(turn()), null)
    expect(a).toBe(wordsOf(agent(turn()), null))
    expect(wordsOf(agent(turn({ latest: { text: 'Next.', tone: 'done' } })), null)).not.toBe(a)
  })

  it('has nothing to unfold while a sent reply stands, or with no turn', () => {
    expect(wordsOf(agent(turn()), 'on it')).toBeNull()
    expect(wordsOf(agent(null), null)).toBeNull()
  })

  it('has nothing to unfold on a live status', () => {
    expect(wordsOf(agent(turn({ latest: { text: 'Brewing…', tone: 'working' } })), null)).toBeNull()
  })
})

describe('the card\'s gestures', () => {
  it('the wheel over unfolded words scrolls them, not the crew', () => {
    const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
    expect(view).toMatch(/closest\?\.\('textarea, input, select, \[role="dialog"\], \.zv-body\.open'\)/)
  })

  it('both cards draw the one body', () => {
    for (const file of ['ZoomParts.tsx', 'AgentCard.tsx']) {
      expect(readFileSync(`src/renderer/src/zoom/${file}`, 'utf8')).toContain('<CardBody agent={agent} sent={reply.sent}')
    }
  })
})
