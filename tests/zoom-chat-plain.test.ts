// CHAT IS A PLAIN CONVERSATION (owner, 2026-11-01): no gold edge on the turn
// the reader is at, no checkpoint heading over each exchange (the "T1 …" pill
// repeated the prompt word for word), and no checkpoint rail down the right.
// Its scrollbar is the chat's own: dragging it moves through the conversation
// itself. LOG and LIVE keep the rail.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (...p: string[]): string => readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', ...p), 'utf8')
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at))
}

describe('CHAT is a plain conversation', () => {
  const paper = src('transcript-paper.css')

  it('draws no gold edge or tint on the turn the reader is at', () => {
    const active = rule(paper, '.lod-overlay .look-chat .ctx-block.active')
    expect(active).toContain('box-shadow: none;')
    expect(active).toContain('background: transparent;')
  })

  it('sets no checkpoint heading over an exchange', () => {
    expect(rule(paper, '.lod-overlay .look-chat .ctx-block-head')).toContain('display: none;')
  })

  it('mounts no checkpoint rail in CHAT, and keeps it for LOG and LIVE', () => {
    const overlay = src('TerminalOverlay.tsx')
    expect(overlay).toMatch(/\{look !== 'chat' && \(\s*<CheckpointTimeline/)
  })

  it('gives the chat its own scrollbar, so dragging it moves the conversation', () => {
    const bar = rule(paper, '.lod-overlay .look-chat > .ctx-transcript')
    expect(bar).toContain('scrollbar-width: thin;')
    expect(bar).toMatch(/scrollbar-color: \S/)
    // The webkit pseudo the trace surface hides is shown again for the chat (Safari reads only that).
    expect(rule(paper, '.lod-overlay .look-chat > .ctx-transcript::-webkit-scrollbar')).toContain('display: block;')
  })
})
