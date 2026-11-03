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

// LOG the same way (owner, 2026-11-03): both record looks read as plain
// text; only LIVE, the terminal itself, keeps the rail and the checkpoint row.
for (const look of ['chat', 'log'] as const) {
  describe(`${look.toUpperCase()} is plain reading`, () => {
    const paper = src('transcript-paper.css')

    it('draws no gold edge or tint on the turn the reader is at', () => {
      const active = rule(paper, `.lod-overlay .look-${look} .ctx-block.active`)
      expect(active).toContain('box-shadow: none;')
      expect(active).toContain('background: transparent;')
    })

    it('sets no checkpoint heading over an exchange', () => {
      expect(rule(paper, `.lod-overlay .look-${look} .ctx-block-head`)).toContain('display: none;')
    })

    it('gives the record its own scrollbar, so dragging it moves the conversation', () => {
      const bar = rule(paper, `.lod-overlay .look-${look} > .ctx-transcript`)
      expect(bar).toContain('scrollbar-width: thin;')
      expect(bar).toMatch(/scrollbar-color: \S/)
      // The webkit pseudo the trace surface hides is shown again (Safari reads only that).
      expect(rule(paper, `.lod-overlay .look-${look} > .ctx-transcript::-webkit-scrollbar`)).toContain('display: block;')
    })
  })
}

describe('only LIVE keeps the checkpoints', () => {
  const overlay = src('TerminalOverlay.tsx')

  it('draws the whole rail in LIVE only; CHAT and LOG keep just its tag while scrolling', () => {
    expect(overlay).not.toMatch(/\{look === 'live' && \(\s*<CheckpointTimeline/)
    const rail = overlay.slice(overlay.indexOf('<CheckpointTimeline'), overlay.indexOf('/>', overlay.indexOf('<CheckpointTimeline')))
    expect(rail).toContain("tagOnly={look !== 'live'}")
  })

  it('shows the CHECKPOINT row and its LIVE button in LIVE only', () => {
    expect(overlay).toMatch(/\{selectedIndex !== null && look === 'live' && \(\s*<div className="popout-ask"/)
  })
})
