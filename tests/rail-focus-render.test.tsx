// WHAT THE RAIL RENDERS ONCE A FOCUS IS PRESENT, ON A TWO-CHECKPOINT CARD (D2,
// canvas QA 2026-09-07, dev 91c7314).
//
// The FOCUS never existed on a short card (tests/rail-focus-policy.test.ts owns
// that arithmetic); this file owns what the rail draws once it does. The row
// used to carry ROLE / FORK / ⟲ REWIND; the owner retired all three on
// 2026-11-03, so the tag names the turn and nothing more.
//
// House pattern: no jsdom. renderToStaticMarkup over a stubbed window, and
// vi.resetModules + dynamic import for the module-scope globals api-base and
// auth-gate read once at load.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { rowsOfIndex } from '../src/renderer/src/stream/stream-rows'
import type { StreamCheckpoint } from '../src/renderer/src/stream/stream-types'

/** A desktop bridge that COULD save a role, fork and rewind — so a tag with no
 *  actions on it is the rail's choice, not a missing capability. */
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
    removeEventListener: () => undefined,
    cookrew: {
      saveRole: () => Promise.resolve(),
      restoreCheckpoint: () => Promise.resolve({ ok: true }),
      forkTerminal: () => Promise.resolve()
    }
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
}

const row = (ordinal: number): StreamCheckpoint => ({
  identity: `u${ordinal}`,
  ordinal,
  startedAt: ordinal,
  endedAt: ordinal,
  promptHead: `prompt ${ordinal}`,
  compacted: false,
  file: '/s1.jsonl'
})

/** The QA card: two checkpoints, a transcript shorter than one screen. */
const shortCard = async (props: Record<string, unknown> = {}): Promise<string> => {
  stubDesktop()
  vi.resetModules()
  const { CheckpointTimeline } = await import('../src/renderer/src/CheckpointTimeline')
  return renderToStaticMarkup(
    <CheckpointTimeline
      terminalId="t1"
      rows={rowsOfIndex([row(1), row(2)])}
      total={2}
      titleMode="conclusion"
      onGoto={() => undefined}
      onLive={() => undefined}
      onScrub={() => undefined}
      {...props}
    />
  )
}

describe('a focused checkpoint names its turn and carries no actions', () => {
  // The focus is SEEDED from the incoming scroll position now, not computed in
  // an effect — which is why a static render can see the tag at all, and why a
  // card that opens already on a checkpoint has its tag on the FIRST paint.
  it('mounts the focus tag for the checkpoint in view', async () => {
    const markup = await shortCard({ activeIndex: 2, markerFrac: 0.5 })
    expect(markup).toContain('cr-ckpt-scrub-preview')
    expect(markup).toContain('cr-ckpt-fan-focus')
  })

  it('carries no ROLE, FORK or ⟲ REWIND (retired 2026-11-03)', async () => {
    const markup = await shortCard({ activeIndex: 2, markerFrac: 0.5 })
    expect(markup).not.toContain('cr-ckpt-row-actions')
    expect(markup).not.toContain('cr-ckpt-action')
    for (const action of ['ROLE', 'FORK', 'REWIND']) expect(markup).not.toContain(action)
  })

  it('draws no tag at the live tail, which is still the resting state', async () => {
    const markup = await shortCard({})
    expect(markup).not.toContain('cr-ckpt-scrub-preview')
  })

  it('a read-only embedder still gets no actions at all', async () => {
    const markup = await shortCard({ activeIndex: 2, markerFrac: 0.5, allowActions: false })
    expect(markup).toContain('cr-ckpt-scrub-preview')
    expect(markup).not.toContain('cr-ckpt-row-actions')
  })
})

// SOURCE PROXIES — the wiring a static render cannot reach, asserted as the one
// thing source text can honestly say: that the call exists.
describe('the rail hands the focus to the policy, not to the scroll', () => {
  const rail = readFileSync(
    join(__dirname, '../src/renderer/src/CheckpointTimeline.tsx'),
    'utf8'
  ).replace(/\s+/g, ' ')

  it('a tap on the bar pins a selection', () => {
    expect(rail).toContain("nextFocus(state, { kind: 'tap', focus: target.focus, at: Date.now() })")
  })

  it('a lifted scrub starts its dwell, so the fan outlives the finger', () => {
    expect(rail).toContain("nextFocus(state, { kind: 'release', at: Date.now() })")
  })

  it('the fan stays mounted while pinned, not only while scrubbing', () => {
    expect(rail).toContain(
      'const fanned = focused !== null && focusedRow !== null && (scrubbing || pinned)'
    )
  })

  it('holds no row actions and no press-and-hold to reveal them', () => {
    for (const gone of ['forkTerminal', 'restoreCheckpoint', 'SaveRoleInline', 'createHoldReveal', 'rowActions']) {
      expect(rail).not.toContain(gone)
    }
  })

  it('the idle fade cannot hide a pinned tag out from under the user', () => {
    expect(rail).toContain('!lineageOpen && !pinned')
  })

  it('LIVE is the way out of a pin, and always obeyed', () => {
    expect(rail).toContain("nextFocus(state, { kind: 'live', at: Date.now() })")
  })
})

// CHAT AND LOG KEEP ONLY THE TAG (owner, 2026-11-03): no line, no ticks, no CP
// count and no live dot, and the native scrollbar is the way through; but the
// tag that names the turn in view while scrolling stays (its ROLE / FORK /
// ⟲ REWIND went the same day).
describe('a tag-only rail, for CHAT and LOG', () => {
  it('draws the focus tag alone, and no bar at all', async () => {
    const markup = await shortCard({ activeIndex: 2, markerFrac: 0.5, tagOnly: true })
    expect(markup).toContain('cr-ckpt-rail tag-only')
    expect(markup).toContain('cr-ckpt-scrub-preview')
    const tag = markup.slice(markup.indexOf('cr-ckpt-scrub-preview'))
    expect(tag).toContain('T2')
    for (const action of ['ROLE', 'FORK', 'REWIND']) expect(tag).not.toContain(action)
    for (const part of ['cr-ckpt-mini', 'cr-ckpt-line', 'cr-ckpt-count', 'cr-ckpt-livedot', 'cr-ckpt-here']) expect(markup).not.toContain(part)
  })

  it('draws nothing at the live tail', async () => {
    const markup = await shortCard({ tagOnly: true })
    expect(markup).not.toContain('cr-ckpt-scrub-preview')
  })

  it('lets the transcript under it take every press: only the tag’s rows are hit', () => {
    const css = readFileSync(join(__dirname, '../src/renderer/src/agent-roster.css'), 'utf8')
    expect(css).toMatch(/\.cr-ckpt-rail\.tag-only \{[^}]*pointer-events: none;/)
  })
})
