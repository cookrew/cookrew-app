import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TurnRefusedView } from '../src/renderer/src/zoom/TurnRefused'
import { wordsOf } from '../src/renderer/src/zoom/CardBody'
import { CardWords } from '../src/renderer/src/zoom/quick-reply'
import { askedTurn, createSimpleFixes, simpleFixes } from '../src/renderer/src/zoom/simple-fix'
import { REFUSED_COPY } from '../src/shared/first-run-copy'
import { lineOf, type AgentView } from '../src/renderer/src/zoom/zoom-model'
import type { AgentRow } from '../src/renderer/src/agent-rows'
import type { TerminalActivity } from '../src/shared/turn'

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

describe('the press outlives the card that took it (N10)', () => {
  // A restart takes the card through a new pane with nothing on it, so the refusal
  // goes and comes back and the words around it change. Every render below is a new
  // mount with no state of its own: what the card says must come from outside it.
  const restarted = { ok: true, restarted: true, state: { rows: [], keyStore: 'file', active: null } } as const
  const card = (over: Partial<AgentView> = {}): string =>
    renderToStaticMarkup(<CardWords agent={{ ...agent(), ...over }} sent={null} />)
  const agent = (): AgentView => ({ id: 'n10', name: 'Folder Tour', preset: 'Claude Code', status: 'failed', refused: RAW, turn: { latest: { tone: 'done', text: RAW, full: RAW } } }) as unknown as AgentView
  const gate = <T,>() => {
    let open: (value: T) => void = () => undefined
    return { wait: new Promise<T>((resolve) => (open = resolve)), open: (value: T) => open(value) }
  }

  it('says Restarting on a card mounted while the restart runs, and the confirmation after', async () => {
    simpleFixes.forget('n10')
    const answer = gate<typeof restarted>()
    const press = simpleFixes.press('n10', RAW, () => answer.wait)
    expect(card()).toContain(REFUSED_COPY.SIMPLE_WORKING)
    answer.open(restarted)
    await press
    expect(card()).toContain(REFUSED_COPY.SIMPLE_DONE)
    expect(card()).toContain('Send your task again')
  })

  it('keeps it on a card whose refusal has gone for a moment: the new pane is blank', async () => {
    simpleFixes.forget('n10')
    await simpleFixes.press('n10', RAW, async () => restarted)
    const html = card({ refused: null, turn: null })
    expect(html).toContain(REFUSED_COPY.SIMPLE_DONE)
    expect(html).toContain(REFUSED_COPY.request)
  })

  it('keeps it when the refusal comes back in other words', async () => {
    simpleFixes.forget('n10')
    await simpleFixes.press('n10', RAW, async () => restarted)
    const other = `${RAW}\nRead back from the transcript.`
    const html = card({ refused: RAW.slice(0, 20), turn: { latest: { tone: 'done', text: RAW, full: other } } as AgentView['turn'] })
    expect(html).toContain(REFUSED_COPY.SIMPLE_DONE)
  })

  it('lets go of a healthy card it has nothing more to say on', async () => {
    simpleFixes.forget('n10')
    await simpleFixes.press('n10', RAW, async () => ({ ...restarted, restarted: false }))
    expect(card({ refused: null, turn: null })).not.toContain(REFUSED_COPY.SIMPLE_SAVED)
    await simpleFixes.press('n10', RAW, async () => ({ ok: false }))
    expect(card({ refused: null, turn: null })).not.toContain(REFUSED_COPY.SIMPLE_GO)
  })

  it('says what is true when the card would not restart', async () => {
    simpleFixes.forget('n10')
    await simpleFixes.press('n10', RAW, async () => ({ ...restarted, restarted: false }))
    expect(card()).toContain(REFUSED_COPY.SIMPLE_SAVED)
  })

  it('leaves the words a card with no press has alone', () => {
    simpleFixes.forget('n10')
    expect(card()).not.toContain(REFUSED_COPY.SIMPLE_DONE)
    expect(card({ id: 'another' })).not.toContain(REFUSED_COPY.SIMPLE_WORKING)
  })
})

describe('what is kept of a press', () => {
  const answer = (restarted: boolean) => ({ ok: true as const, restarted, state: { rows: [], keyStore: 'file' as const, active: null } })
  const rig = () => {
    let started = false
    let tell = (): void => undefined
    const fixes = createSimpleFixes({
      turnStarted: () => started,
      watch: (cb) => {
        tell = cb
        return () => undefined
      }
    })
    return { fixes, turn: (next: boolean) => ((started = next), tell()) }
  }

  it('sends once, however often it is pressed while it runs', async () => {
    const { fixes } = rig()
    const send = vi.fn(async () => answer(true))
    await Promise.all([fixes.press('a', RAW, send), fixes.press('a', RAW, send)])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('goes when the next turn starts: a later refusal is a new question', async () => {
    const { fixes, turn } = rig()
    await fixes.press('a', RAW, async () => answer(true))
    turn(true)
    expect(fixes.get('a')).toBeNull()
  })

  it('stays through the restart itself, whatever the phase says then', async () => {
    const { fixes, turn } = rig()
    let open: (value: ReturnType<typeof answer>) => void = () => undefined
    const press = fixes.press('a', RAW, () => new Promise((resolve) => (open = resolve)))
    turn(true)
    expect(fixes.get('a')?.state).toBe('working')
    turn(false)
    open(answer(true))
    await press
    expect(fixes.get('a')?.state).toBe('done')
  })

  it('is not ended by a spinner in the new pane’s boot output, which nobody asked for', () => {
    const on = { terminalId: 'a', agent: true, phase: 'thinking' } as TerminalActivity
    expect(askedTurn(on)).toBe(false)
    expect(askedTurn({ ...on, asked: false })).toBe(false)
    expect(askedTurn({ ...on, asked: true })).toBe(true)
  })

  it('is ended by a question as well: a card with no mirror goes straight to waiting', () => {
    const on = { terminalId: 'a', agent: true, phase: 'waiting', mirrorless: true } as TerminalActivity
    expect(askedTurn(on)).toBe(true)
  })

  it('reads a card at rest as no turn', () => {
    expect(askedTurn({ terminalId: 'a', agent: true, phase: 'idle', asked: true } as TerminalActivity)).toBe(false)
    expect(askedTurn(undefined)).toBe(false)
  })

  it('keeps the words it was pressed on', async () => {
    const { fixes } = rig()
    await fixes.press('a', RAW, async () => answer(true))
    expect(fixes.get('a')?.raw).toBe(RAW)
  })

  it('reads a refusal or a broken bridge as failed, and may be pressed again', async () => {
    const { fixes } = rig()
    await fixes.press('a', RAW, async () => ({ ok: false }))
    expect(fixes.get('a')?.state).toBe('failed')
    await fixes.press('a', RAW, async () => {
      throw new Error('gone')
    })
    expect(fixes.get('a')?.state).toBe('failed')
    await fixes.press('a', RAW, async () => answer(false))
    expect(fixes.get('a')?.state).toBe('saved')
  })

  it('tells who is listening, and only when something changed', async () => {
    const { fixes } = rig()
    const heard = vi.fn()
    const off = fixes.subscribe(heard)
    await fixes.press('a', RAW, async () => answer(true))
    expect(heard).toHaveBeenCalledTimes(2)
    off()
    fixes.forget('a')
    expect(heard).toHaveBeenCalledTimes(2)
  })
})
