import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TurnPagerBar, type TurnPaging } from '../src/renderer/src/nodes/TurnPager'

const source = (file: string): string =>
  readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8')

describe('placed crew zoomed view — PTY-direct (owner ruling 2026-08-30)', () => {
  it('the live slot is the xterm PTY for every card; the composer replacement is gone', () => {
    const overlay = source('TerminalOverlay.tsx')
    // The transcript backbone and the rail stay — the revert is the live slot only.
    expect(overlay).toContain('<TranscriptView')
    expect(overlay).toContain('<CheckpointTimeline')
    // aa3198a's swap: a crew card must never trade its PTY for a composer again.
    expect(overlay).not.toContain('ServedCrewLive')
    expect(overlay).toContain('<div ref={containerRef} className="popout-terminal" />')
    // …and the xterm mount must not be gated off for crew cards.
    expect(overlay).not.toContain('if (remoteCrew) return\n    const container')
    // The served trace still feeds the rail, and remote sessions stay read-only.
    expect(overlay).toContain('refreshToken={remoteCrew ? traceRefresh : 0}')
    expect(overlay).toContain('allowActions={!remoteCrew}')
  })

  it('keeps checkpoint navigation while withholding local session mutations', () => {
    const html = renderToStaticMarkup(
      <TurnPagerBar
        paging={
          {
            viewing: null,
            position: null,
            count: 2,
            records: null,
            back: () => undefined,
            forward: () => undefined,
            live: () => undefined,
            goto: () => undefined,
            fork: () => undefined,
            forking: false,
            forkable: false
          } satisfies TurnPaging
        }
      />
    )
    expect(html).toContain('Previous checkpoint')
    expect(html).toContain('LIVE · 2 CHECKPOINTS')
    expect(html).not.toContain('Fork a new agent')
  })
})
