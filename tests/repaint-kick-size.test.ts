// THE REPAINT KICK GOES BACK TO THE SIZE IT FOUND (owner, 2026-10-31: a
// blank row under every line in LIVE, and the input box jumping).
//
// The kick widens the pane one column and settles back. Main takes a widen one
// column further (PtySession.resize) and tells every viewer, which adopts it;
// settling on term.cols then kept that overshoot, so the pane grew two columns
// a kick while the viewer's box stayed put, and every row overflowed its grid.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const overlay = readFileSync(path.join(__dirname, '..', 'src/renderer/src', 'TerminalOverlay.tsx'), 'utf8')
const kick = overlay.slice(overlay.indexOf('const repaintKick'), overlay.indexOf('kickRef.current = repaintKick'))

describe('repaintKick', () => {
  it('reads the pane size once, before the nudge, and settles back to exactly that', () => {
    expect(kick).toContain('const at = paneSize ?? { cols: term.cols, rows: term.rows }')
    expect(kick).toContain('sendSize(at.cols + 1, at.rows, true)')
    expect(kick).toContain('sendSize(at.cols, at.rows)')
  })

  it('never settles on term.cols, which by then holds the adopted overshoot', () => {
    expect(kick).not.toMatch(/sendSize\(term\.cols/)
  })

  it('the mount fit tells the pane whenever the grid differs from the pane, not from what it last sent', () => {
    const fitStable = overlay.slice(overlay.indexOf('const fitUntilStable'), overlay.indexOf('fitUntilStable()\n'))
    expect(fitStable).toContain('if (paneSize?.cols !== term.cols || paneSize?.rows !== term.rows) sendSize(term.cols, term.rows)')
    expect(overlay).not.toContain('lastSent')
  })
})
