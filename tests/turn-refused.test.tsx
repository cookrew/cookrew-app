import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TurnRefusedView } from '../src/renderer/src/zoom/TurnRefused'
import { wordsOf } from '../src/renderer/src/zoom/CardBody'
import { CardWords } from '../src/renderer/src/zoom/quick-reply'
import { REFUSED_COPY } from '../src/shared/first-run-copy'
import { lineOf, type AgentView } from '../src/renderer/src/zoom/zoom-model'
import type { AgentRow } from '../src/renderer/src/agent-rows'

/**
 * Box round 3, N3: a refused turn read FAILED and a Jinja template error, the real
 * fix was not mentioned, and reaching it took Remove and the key typed again.
 */

const RAW = 'API Error: 400 Unable to generate parser for this template'
const view = (over: Partial<Parameters<typeof TurnRefusedView>[0]> = {}): string =>
  renderToStaticMarkup(<TurnRefusedView raw={RAW} offer={false} state="idle" onFix={vi.fn()} {...over} />)

describe('a refused turn on its card', () => {
  it('says what happened in a sentence, ahead of the provider’s own words', () => {
    const html = view()
    expect(html).toContain(REFUSED_COPY.request)
    expect(html.indexOf(REFUSED_COPY.request)).toBeLessThan(html.indexOf(RAW))
  })

  it('keeps the raw text, folded, behind details', () => {
    const html = view()
    expect(html).toMatch(/<details[^>]*>(?!.*open)/)
    expect(html).toContain(`<summary>${REFUSED_COPY.DETAILS}</summary>`)
    expect(html.slice(html.indexOf('<details'))).toContain(RAW)
    expect(html.slice(0, html.indexOf('<details'))).not.toContain(RAW)
  })

  it('offers simple mode only when it is the fix', () => {
    expect(view()).not.toContain(REFUSED_COPY.SIMPLE_GO)
    const html = view({ offer: true })
    expect(html).toContain(REFUSED_COPY.SIMPLE_WHY)
    expect(html).toContain(`>${REFUSED_COPY.SIMPLE_GO}<`)
  })

  it.each(['API Error: 401 nope', 'Error: 429 rate limited', 'API Error (500 Internal Server Error)', 'API Error: Connection error.'])('does not offer it for what it cannot fix: %s', (raw) => {
    expect(view({ raw, offer: true })).not.toContain(REFUSED_COPY.SIMPLE_GO)
  })

  it('says it reaches beyond this card', () => {
    expect(REFUSED_COPY.SIMPLE_WHY).toContain('every Claude Code agent')
    expect(REFUSED_COPY.SIMPLE_SAVED).toContain('every Claude Code agent')
  })

  it('puts the press first: a short card clips what comes last, and a screenshot caught it clipping this', () => {
    const html = view({ offer: true })
    expect(html.indexOf(REFUSED_COPY.SIMPLE_GO)).toBeLessThan(html.indexOf(REFUSED_COPY.SIMPLE_WHY))
    expect(html.indexOf(REFUSED_COPY.SIMPLE_GO)).toBeLessThan(html.indexOf('<details'))
  })

  it('shows the press going, then what to do next', () => {
    expect(view({ offer: true, state: 'working' })).toMatch(/<button[^>]*disabled=""/)
    expect(view({ offer: true, state: 'done' })).toContain(REFUSED_COPY.SIMPLE_DONE)
    expect(view({ offer: true, state: 'done' })).not.toContain(`>${REFUSED_COPY.SIMPLE_GO}<`)
  })

  it('tells the truth when the card would not restart', () => {
    expect(view({ offer: true, state: 'saved' })).toContain(REFUSED_COPY.SIMPLE_SAVED)
  })

  it('says it when the press failed', () => {
    expect(view({ offer: true, state: 'failed' })).toContain(REFUSED_COPY.SIMPLE_FAILED)
  })
})

describe('the card picks it', () => {
  const agent = { id: 'a', name: 'Folder Tour', preset: 'Claude Code', status: 'failed', refused: RAW, turn: { latest: { tone: 'done', text: RAW, full: RAW } } } as unknown as AgentView

  it('draws the refusal in place of the raw reply', () => {
    const html = renderToStaticMarkup(<CardWords agent={agent} sent={null} />)
    expect(html).toContain(REFUSED_COPY.request)
    expect(html).toContain('<details')
  })

  it('gives way to a reply just sent', () => {
    expect(renderToStaticMarkup(<CardWords agent={agent} sent="again" />)).not.toContain(REFUSED_COPY.request)
  })

  it('says the sentence, not the provider’s words, anywhere the card is one line', () => {
    expect(lineOf({ refused: RAW, turn: { latest: { tone: 'done', text: RAW } } } as unknown as AgentRow, null)).toBe(REFUSED_COPY.request)
  })

  it('unfolds like any reply when the card is too short for it', () => {
    expect(wordsOf(agent, null)).toBe(RAW)
  })
})
