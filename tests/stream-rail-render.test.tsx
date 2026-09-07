// WHAT THE RAIL DRAWS FOR THE STREAM'S THREE NEW FACTS (one-stream T3).
//
// A rolled-back position, a compaction boundary and a count of unreadable
// lines are things the old rail could not represent — the first two because
// its coordinate system had no room for them, the third because a line the
// reader could not parse simply vanished. All three are markup now, so they
// are asserted on markup: a static render runs the component body and the
// output IS the picture.
//
// House pattern: no jsdom. renderToStaticMarkup over a stubbed window, and
// vi.resetModules + dynamic import for the module-scope globals api-base and
// auth-gate read once at load.

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { rowsOfIndex } from '../src/renderer/src/stream/stream-rows'
import type { StreamCheckpoint } from '../src/renderer/src/stream/stream-types'

const stubDesktop = (): void => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    location: { origin: 'http://localhost', search: '', hash: '', href: 'http://localhost/' },
    localStorage: storage,
    sessionStorage: storage,
    history: { replaceState: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
}

const row = (ordinal: number, extra: Partial<StreamCheckpoint> = {}): StreamCheckpoint => ({
  identity: `u${ordinal}`,
  ordinal,
  startedAt: ordinal,
  endedAt: ordinal,
  promptHead: `prompt ${ordinal}`,
  compacted: false,
  file: '/s1.jsonl',
  ...extra
})

const rowView = async (entry: StreamCheckpoint): Promise<string> => {
  stubDesktop()
  vi.resetModules()
  const { CheckpointRowView } = await import('../src/renderer/src/CheckpointRowView')
  const { checkpointRowTitle } = await import('../src/renderer/src/stream/stream-rows')
  const projected = rowsOfIndex([entry])[0]
  return renderToStaticMarkup(
    <CheckpointRowView
      row={projected}
      label={checkpointRowTitle(projected, 'conclusion')}
      active={false}
      acting={false}
      loading={false}
      titleShift={0}
      actions={null}
      onPressStart={() => undefined}
      onPressEnd={() => undefined}
      onSelect={() => undefined}
    />
  )
}

const rail = async (props: Record<string, unknown>): Promise<string> => {
  stubDesktop()
  vi.resetModules()
  const { CheckpointTimeline } = await import('../src/renderer/src/CheckpointTimeline')
  return renderToStaticMarkup(
    <CheckpointTimeline
      terminalId="t1"
      rows={rowsOfIndex([row(1), row(2), row(3)])}
      titleMode="conclusion"
      onGoto={() => undefined}
      onLive={() => undefined}
      {...props}
    />
  )
}

describe('a rolled-back checkpoint is dimmed, glyphed, and still selectable', () => {
  it('takes the dimming class rather than being dropped from the list', async () => {
    const markup = await rowView(row(4, { rolledBack: true }))
    expect(markup).toContain('cr-ckpt-row')
    expect(markup).toContain('rolled-back')
  })

  it('carries the ↶ glyph', async () => {
    expect(await rowView(row(4, { rolledBack: true }))).toContain('↶')
  })

  it('says so to a screen reader, which a dimming class cannot', async () => {
    expect(await rowView(row(4, { rolledBack: true }))).toContain(
      'aria-label="Checkpoint 4, rolled back"'
    )
  })

  it('stays SELECTABLE — no disabled state, no aria-disabled', async () => {
    const markup = await rowView(row(4, { rolledBack: true }))
    expect(markup).not.toContain('aria-disabled')
    expect(markup).not.toContain('disabled=""')
  })

  it('an ordinary row carries none of it', async () => {
    const markup = await rowView(row(4))
    expect(markup).not.toContain('rolled-back')
    expect(markup).not.toContain('↶')
  })
})

describe('a compaction boundary is a thin rule that says "compacted"', () => {
  it('renders on the row AFTER the boundary, as a separator', async () => {
    const markup = await rowView(row(5, { compacted: true }))
    expect(markup).toContain('cr-ckpt-compacted')
    expect(markup).toContain('compacted')
    expect(markup).toContain('role="separator"')
    expect(markup).toContain('aria-label="Compacted here"')
  })

  it('is absent where nothing was compacted', async () => {
    expect(await rowView(row(5))).not.toContain('cr-ckpt-compacted')
  })
})

describe('the title comes from the mark (item 5)', () => {
  it('shows the Sous title in conclusion mode', async () => {
    expect(await rowView(row(6, { marks: { title: 'fixed the seam' } }))).toContain(
      'fixed the seam'
    )
  })

  it('falls back to the prompt head, never to blank', async () => {
    expect(await rowView(row(6))).toContain('prompt 6')
  })
})

describe('the anomaly line — one quiet line in the footer, never a modal', () => {
  it('renders the sentence the hook already phrased', async () => {
    const markup = await rail({ anomalyNote: '3 lines the stream could not read' })
    expect(markup).toContain('cr-ckpt-anomaly')
    expect(markup).toContain('3 lines the stream could not read')
  })

  it('is a status, not a dialog — nothing to dismiss and nothing to block on', async () => {
    const markup = await rail({ anomalyNote: '3 lines the stream could not read' })
    expect(markup).toContain('role="status"')
    expect(markup).not.toContain('role="dialog"')
    expect(markup).not.toContain('role="alertdialog"')
  })

  it('says nothing when the stream read every line', async () => {
    expect(await rail({})).not.toContain('cr-ckpt-anomaly')
  })
})

describe('the rail draws its boundaries from the stream’s own rows', () => {
  it('a compaction row becomes a ◆ tick on the bar', async () => {
    const { markersOfIndex } = await import('../src/renderer/src/stream/stream-rows')
    const index = [row(1), row(2, { compacted: true, compaction: { preTokens: 9, postTokens: 2 } })]
    const markup = await rail({
      rows: rowsOfIndex(index),
      markers: markersOfIndex(index)
    })
    expect(markup).toContain('cr-ckpt-tick')
    expect(markup).toContain('compact here')
  })

  it('a card with no checkpoints draws no rail at all', async () => {
    expect(await rail({ rows: [] })).toBe('')
  })
})
