// THE TAG, ON EVERY VIEW OF A CARD.
//
// One component draws it in three places — the canvas card, the roster row and
// the zoomed header — so the thing worth pinning is that it reads the SAME on
// all of them, and that it draws nothing at all for a card whose dials nobody
// has recorded. A blank chip beside the harness name would be a claim about
// what the agent is running on.

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { DialTag } from '../src/renderer/src/nodes/DialTag'
import { tuningStore } from '../src/renderer/src/tuning-store'
import type { AgentTuning } from '../src/shared/agent-tuning'

const T0 = 1_759_000_000_000

function seed(id: string, tuning: AgentTuning): void {
  tuningStore.set(id, tuning)
}

afterEach(() => tuningStore.clear())

describe('the dial tag', () => {
  it('wears the model and the effort, harness-shaped', () => {
    seed('codex-1', { model: 'gpt-6-astra', effort: 'high', at: T0 })
    expect(renderToStaticMarkup(<DialTag id="codex-1" />)).toContain('gpt-6-astra high')
  })

  it('abbreviates a claude model to the alias the picker offers', () => {
    seed('forge', { model: 'claude-opus-5', effort: 'max', at: T0 })
    const html = renderToStaticMarkup(<DialTag id="forge" />)
    expect(html).toContain('opus max')
    // The unabbreviated reading is still one hover away.
    expect(html).toContain('title="claude-opus-5 · effort max"')
  })

  it('draws NOTHING for a card nobody has recorded dials for', () => {
    expect(renderToStaticMarkup(<DialTag id="never-replied" />)).toBe('')
  })

  it('draws nothing when the record carries neither half', () => {
    seed('blank', { model: null, effort: null, at: null })
    expect(renderToStaticMarkup(<DialTag id="blank" />)).toBe('')
  })

  it('stacks the two parts for a surface too narrow for one line', () => {
    // Measured on the live board: the one-line tag needed 402px in a 253px
    // box and clipped on all 23 tiles, which cost the EFFORT every time —
    // the half you cannot reconstruct from the card's avatar or position.
    seed('forge', { model: 'claude-opus-5', effort: 'max', at: T0 })
    const html = renderToStaticMarkup(<DialTag id="forge" className="vi-mini-dial" stack />)
    expect(html).toContain('<span class="dial-model">opus</span>')
    expect(html).toContain('<span class="dial-effort">max</span>')
    // Two clippable boxes, so a long model id clips ALONE.
    expect(html).not.toContain('opus max')
  })

  it('stacks whichever half it has, and still draws nothing with neither', () => {
    seed('half', { model: 'gpt-6-astra', effort: null, at: T0 })
    const one = renderToStaticMarkup(<DialTag id="half" stack />)
    expect(one).toContain('gpt-6-astra')
    expect(one).not.toContain('dial-effort')
    seed('none', { model: null, effort: null, at: null })
    expect(renderToStaticMarkup(<DialTag id="none" stack />)).toBe('')
  })

  it('takes each surface’s own chip class so it inherits that geometry', () => {
    seed('forge', { model: 'claude-opus-5', effort: 'max', at: T0 })
    // The canvas card's chips are .vi-chip; the roster and the zoomed header
    // use .cr-chip. One component, each surface's kit.
    expect(renderToStaticMarkup(<DialTag id="forge" />)).toContain('class="vi-chip dial"')
    expect(renderToStaticMarkup(<DialTag id="forge" className="cr-chip dial" />)).toContain(
      'class="cr-chip dial"'
    )
  })
})

/**
 * EVERY CARD VIEW, and the one that was missed.
 *
 * The first cut left the mini tile out, reasoning that it names no harness so a
 * tag had nothing to sit beside. True, and beside the point: the board sits at
 * OVERVIEW zoom — measured live, 32 of 32 cards were `.vi-card.mini` at scale
 * 0.1 — so the feature was invisible in the view that is usually on screen.
 *
 * Source-level because a terminal card's branches need React Flow context to
 * render, and because the defect is a MISSING branch: no fixture can fail on a
 * view nobody wrote. Slicing on the branch guards is admittedly brittle; the
 * guards are asserted first so a rename fails loudly here instead of silently
 * passing a sliced-to-nothing string.
 */
describe('every card view carries the tag', () => {
  const source = readFileSync(
    path.join(__dirname, '..', 'src/renderer/src/nodes/TerminalNode.tsx'),
    'utf8'
  )
  const MINI = "if (mode === 'mini')"
  const SHELL = 'if (!agent)'

  it('has the three branches these slices assume', () => {
    expect(source).toContain(MINI)
    expect(source).toContain(SHELL)
    expect(source.indexOf(MINI)).toBeLessThan(source.indexOf(SHELL))
  })

  it('draws it in the mini tile — the overview, where the whole board lives', () => {
    const mini = source.slice(source.indexOf(MINI), source.indexOf(SHELL))
    expect(mini).toContain('<DialTag')
  })

  it('draws it in the shell card and the full agent card', () => {
    // Two top-level `return (` follow the !agent guard: the shell card's own,
    // then the agent card's. Split on the second so each slice is one branch.
    const rest = source.slice(source.indexOf(SHELL))
    const shellReturn = rest.indexOf('return (')
    const agentReturn = rest.indexOf('return (', shellReturn + 1)
    expect(shellReturn, 'shell branch has no return').toBeGreaterThan(-1)
    expect(agentReturn, 'agent branch has no return').toBeGreaterThan(shellReturn)
    expect(rest.slice(shellReturn, agentReturn), 'shell card lost its tag').toContain('<DialTag')
    expect(rest.slice(agentReturn), 'agent card lost its tag').toContain('<DialTag')
  })

  it('draws it in the roster row and the zoomed header', () => {
    const read = (file: string): string =>
      readFileSync(path.join(__dirname, '..', 'src/renderer/src', file), 'utf8')
    expect(read('AgentRow.tsx'), 'roster row lost its tag').toContain('<DialTag')
    expect(read('TerminalOverlay.tsx'), 'zoomed header lost its tag').toContain('<DialTag')
  })
})
