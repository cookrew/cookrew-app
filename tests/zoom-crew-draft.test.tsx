// THE CREW SAYS WHAT IS TYPED (owner, 2026-11-01): an agent with words
// waiting unsent shows them under its face in the agents view, and the crew
// no longer says "nothing open" under an agent that carries no browser or
// note: that line was noise.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentNode, type Bind } from '../src/renderer/src/zoom/ZoomParts'
import { typingOf } from '../src/renderer/src/zoom/typing-line'
import type { AgentEls } from '../src/renderer/src/zoom/zoom-frame'
import type { AgentView } from '../src/renderer/src/zoom/zoom-model'
import type { TurnViewModel } from '../src/renderer/src/turn-view-model'
import { modelOf, paintAt } from './zoom-qa-helpers'

const bind: Bind = () => () => undefined
const agent = (over: Partial<AgentView> = {}): AgentView => ({
  id: 't1', name: 'Forge', preset: 'Claude Code', orch: false, phase: 'idle', status: 'resting', word: 'resting',
  line: 'done', browsers: 0, notes: 0, turn: null, ...over
} as AgentView)
const turn = (pendingInput: string | null): TurnViewModel => ({ title: null, ask: null, tools: [], latest: null, pendingInput, tail: null })

describe('what the crew says is typed', () => {
  it('is the draft, its first line, trimmed', () => {
    expect(typingOf('  fix the zoom bar\nand the dock  ', null, 'Forge')).toBe('fix the zoom bar')
  })

  it('is what sits unsent in the agent’s own input when there is no draft', () => {
    expect(typingOf('', 'typed in LIVE', 'Forge')).toBe('typed in LIVE')
  })

  it('the draft wins over the terminal’s reading, which lags behind it', () => {
    expect(typingOf('fix the bar', 'fix the', 'Forge')).toBe('fix the bar')
  })

  it('leaves out the @mention that names this agent in the prompt box', () => {
    expect(typingOf('@Forge ship it', null, 'Forge')).toBe('ship it')
    expect(typingOf('@forge  ship it', null, 'Forge')).toBe('ship it')
  })

  // Review, 2026-11-01: the box following Forge holds "@Velvet ship it", and
  // those words go to Velvet; Forge's line stays empty.
  it('is not a draft addressed to another agent, nor a name still being typed', () => {
    expect(typingOf('@Velvet ship it', null, 'Forge')).toBeNull()
    expect(typingOf('@Forgery ship it', null, 'Forge')).toBeNull()
    expect(typingOf('@Ve', null, 'Forge')).toBeNull()
    expect(typingOf('@Velvet ship it', 'git push', 'Forge')).toBe('git push')
  })

  it('is nothing when nothing is typed, or only the mention is', () => {
    expect(typingOf('', null, 'Forge')).toBeNull()
    expect(typingOf('   ', '  ', 'Forge')).toBeNull()
    expect(typingOf('@Forge ', null, 'Forge')).toBeNull()
  })
})

describe('the crew face', () => {
  it('does not say "nothing open" under an agent that carries nothing', () => {
    const html = renderToStaticMarkup(<AgentNode agent={agent()} card={false} bind={bind} onOpen={() => undefined} />)
    expect(html).not.toContain('nothing open')
    expect(html).toContain('<div class="zv-cnt"></div>')
  })

  it('still counts the browsers and notes an agent carries', () => {
    const html = renderToStaticMarkup(<AgentNode agent={agent({ browsers: 2 })} card={false} bind={bind} onOpen={() => undefined} />)
    expect(html).toContain('2 browsers')
  })

  // Static markup reads the draft store's server snapshot (always empty), so
  // the draft's way in is read from the source; typingOf above is its logic.
  it('shows its draft under its face, from its one draft (the reply box’s)', () => {
    const parts = readFileSync('src/renderer/src/zoom/ZoomParts.tsx', 'utf8')
    expect(parts).toContain('const reply = useQuickReply(agent.id, undefined, card)')
    expect(parts).toContain('typingOf(reply.draft, agent.turn?.pendingInput, agent.name)')
  })

  it('shows words typed in its own terminal, unsent', () => {
    const html = renderToStaticMarkup(<AgentNode agent={agent({ turn: turn('git push') })} card={false} bind={bind} onOpen={() => undefined} />)
    expect(html).toMatch(/class="zv-dft"[^>]*><span>git push<\/span>/)
  })

  it('shows no typing line when nothing is typed', () => {
    const html = renderToStaticMarkup(<AgentNode agent={agent()} card={false} bind={bind} onOpen={() => undefined} />)
    expect(html).toMatch(/class="zv-dft"[^>]*><\/div>/)
  })
})

describe('the painter', () => {
  const part = (): HTMLElement & { style: Record<string, string> } => ({ style: { setProperty: () => undefined } }) as never
  const elsOf = (cntW: number) => {
    const e = { node: part(), cardl: part(), card: part(), av: part(), nm: part(), st: part(), cnt: part(), dft: part(), body: null, reply: null, emp: null, dot: null, nmW: 40, stW: 50, cntW }
    return e as unknown as AgentEls & { dft: { style: Record<string, string> } }
  }
  const paintCrew = (cntW: number, sv: number) => {
    const model = modelOf(2)
    const e = elsOf(cntW)
    paintAt(model, { sv, w: 1440, h: 900, narrow: false, focus: 'a1' }, undefined, new Map([['a0', e]]))
    return e
  }
  const y = (t: string): number => parseFloat(t.split(',')[1])

  it('puts the words where the counts would be, under an agent that carries nothing', () => {
    // The crew shows no state word (owner, 2026-11-03): the counts' line is the state's old one, 18 higher.
    expect(y(paintCrew(0, 1).dft.style.transform)).toBe(62)
  })

  it('puts them under the counts when there are counts', () => {
    expect(y(paintCrew(30, 1).dft.style.transform)).toBe(78)
  })

  it('shows them on the crew and not on the open card, whose reply box holds the draft', () => {
    expect(Number(paintCrew(0, 1).dft.style.opacity)).toBe(1)
    const model = modelOf(2)
    const e = elsOf(0)
    paintAt(model, { sv: 2, w: 1440, h: 900, narrow: false, focus: 'a0' }, undefined, new Map([['a0', e]]))
    expect(Number(e.dft.style.opacity)).toBe(0)
  })

  it('the view collects the line with the face’s other words', () => {
    const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
    expect(view).toContain("dft: get(`agent-dft:${a.id}`)")
    expect(view).toContain('useEffect(() => followDrafts(), [])')
  })
})

describe('the words lie over the ties', () => {
  const css = readFileSync('src/renderer/src/zoom/zoom.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('an empty counts line takes no paper patch', () => {
    expect(css).toMatch(/\.zv-cnt:empty\s*\{[^}]*display:\s*none/)
  })

  it('the typed words wear the page’s paper and stop at an ellipsis', () => {
    expect(css).toMatch(/\.zv-dft > span\s*\{[^}]*text-overflow:\s*ellipsis/)
    expect(css).toMatch(/\.zv-dft > span\s*\{[^}]*background:\s*var\(--zv-paper\)/)
  })
})
