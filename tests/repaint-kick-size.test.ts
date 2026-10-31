// THE REPAINT KICK DIPS NARROWER AND GOES BACK TO THE SIZE IT FOUND (owner,
// 2026-10-31: a blank row under every line in LIVE, and the input box jumping).
//
// The kick widened the pane a column and settled on term.cols — by then the
// overshoot every viewer had adopted from main — so the pane grew two columns
// a kick and every row overflowed the viewer's grid. And a wider step at all
// lets a late render at that width spill every row. Now: one column narrower,
// then back to the size read before the kick.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const overlay = readFileSync(path.join(__dirname, '..', 'src/renderer/src', 'TerminalOverlay.tsx'), 'utf8')
const kick = overlay.slice(overlay.indexOf('const repaintKick'), overlay.indexOf('kickRef.current = repaintKick'))

describe('repaintKick', () => {
  it('reads the pane size once, before the nudge, and settles back to exactly that', () => {
    expect(kick).toContain('const at = kickBack ?? paneSize ?? { cols: term.cols, rows: term.rows }')
    expect(kick).toContain('sendSize(at.cols - 1, at.rows, true)')
    expect(kick).toContain('sendSize(at.cols, at.rows)')
  })

  it('never settles on term.cols, which by then holds the adopted dip, and never steps wider', () => {
    expect(kick).not.toMatch(/sendSize\(term\.cols/)
    expect(kick).not.toMatch(/cols \+ 1/)
  })

  it('a kick while one is in flight goes back to the same size, not to the dip it reads now', () => {
    // Measured: the mount kick and a second one met, 177 -> 176 -> 175, and the pane settled at 176.
    expect(kick).toMatch(/kickBack = at\n\s*sendSize\(at\.cols - 1/)
    expect(kick).toMatch(/settleTimer = setTimeout\(\(\) => \{\s*kickBack = null/)
  })

  it('a viewer waits out a dip before deciding the pane took another viewer\'s size', () => {
    expect(overlay).toContain('}, SETTLE_CHECK_MS)')
  })

  it('the mount fit tells the pane whenever the grid differs from the pane, not from what it last sent', () => {
    const fitStable = overlay.slice(overlay.indexOf('const fitUntilStable'), overlay.indexOf('fitUntilStable()\n'))
    expect(fitStable).toContain('if (paneSize?.cols !== term.cols || paneSize?.rows !== term.rows) sendSize(term.cols, term.rows)')
    expect(overlay).not.toContain('lastSent')
  })
})
