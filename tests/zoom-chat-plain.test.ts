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

// LIVE IS THE TERMINAL'S OWN (owner, 2026-11-03): no checkpoint rail at all,
// not even the tag; the terminal's own scrollbar moves through the herdr pane's
// history it holds (desktop: the xterm viewport; phone: the live sheet).
describe('LIVE scrolls by its own bar, CHAT and LOG keep only the tag', () => {
  const overlay = src('TerminalOverlay.tsx')
  const paper = src('transcript-paper.css')

  it('mounts the rail in CHAT and LOG only, and there as its tag', () => {
    const at = overlay.indexOf('<CheckpointTimeline')
    expect(overlay.slice(at - 60, at)).toMatch(/\{isRecordLook\(look\) && \(\s*$/)
    expect(overlay.slice(at, overlay.indexOf('/>', at))).toMatch(/\btagOnly\b(?!=)/)
  })

  it('shows no CHECKPOINT row or its LIVE button in any look', () => {
    expect(overlay).not.toContain('className="popout-ask"')
  })

  it('gives the live terminal its own scrollbar back, on the desktop and the phone', () => {
    const view = rule(paper, '.lod-overlay .look-live .popout-terminal .xterm-viewport')
    expect(view).toContain('scrollbar-width: thin;')
    expect(rule(paper, '.lod-overlay .look-live .popout-terminal .xterm-viewport::-webkit-scrollbar')).toContain('display: block;')
    expect(rule(paper, '.lod-overlay .look-live .cr-live-sheet')).toContain('scrollbar-width: thin;')
    expect(rule(paper, '.lod-overlay .look-live .cr-live-sheet::-webkit-scrollbar')).toContain('display: block;')
  })

  it('keeps no room for a rail beside the terminal any more', () => {
    expect(paper).not.toMatch(/\.ctx-live,?[^{]*\{\s*right: 30px;/)
  })
})
