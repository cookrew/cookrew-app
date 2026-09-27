// THE TAG, ON EVERY VIEW OF A CARD.
//
// One component draws it in three places — the canvas card, the roster row and
// the zoomed header — so the thing worth pinning is that it reads the SAME on
// all of them, and that it draws nothing at all for a card whose dials nobody
// has recorded. A blank chip beside the harness name would be a claim about
// what the agent is running on.

import { afterEach, describe, expect, it } from 'vitest'
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
