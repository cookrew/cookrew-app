// THE ROW ACTIONS ARE IN THE MARKUP, ON A TWO-CHECKPOINT CARD (D2, canvas QA
// 2026-09-07, dev 91c7314).
//
// QA could not reach ROLE / FORK / ⟲ REWIND by real input. Two halves:
// the FOCUS never existed on a short card (tests/rail-focus-policy.test.ts owns
// that arithmetic), and the actions themselves were reachable only through a
// 1500ms press-and-hold on a fan row that existed only while a pointer was held
// down. This file owns the second half — what the rail actually RENDERS once a
// focus is present, and how the stylesheet reveals it.
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

/** A desktop bridge that can save a role and rewind — both actions are
 *  feature-detected, so without this the rail renders FORK alone. */
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

describe('a focused checkpoint brings its actions with it', () => {
  // The focus is SEEDED from the incoming scroll position now, not computed in
  // an effect — which is why a static render can see the tag at all, and why a
  // card that opens already on a checkpoint has its tag on the FIRST paint.
  it('mounts the focus tag for the checkpoint in view', async () => {
    const markup = await shortCard({ activeIndex: 2, markerFrac: 0.5 })
    expect(markup).toContain('cr-ckpt-scrub-preview')
    expect(markup).toContain('cr-ckpt-fan-focus')
  })

  it('carries ROLE, FORK and ⟲ REWIND inside it', async () => {
    const markup = await shortCard({ activeIndex: 2, markerFrac: 0.5 })
    const tag = markup.slice(markup.indexOf('cr-ckpt-scrub-preview'))
    expect(tag).toContain('cr-ckpt-row-actions')
    expect(tag).toContain('ROLE')
    expect(tag).toContain('FORK')
    expect(tag).toContain('⟲ REWIND')
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

describe('the stylesheet reveals them for a pinned focus, with no hold', () => {
  const css = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')

  it('.acting is what shows the strip — the class the pinned focus row takes', () => {
    expect(css).toContain('.cr-ckpt-row.acting .cr-ckpt-row-actions')
  })

  it('hover and focus-within remain, so the desktop pointer is unchanged', () => {
    expect(css).toContain('.cr-ckpt-row:hover .cr-ckpt-row-actions')
    expect(css).toContain('.cr-ckpt-row:focus-within .cr-ckpt-row-actions')
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

  it('a pinned focus row reveals its actions without the 1500ms hold', () => {
    expect(rail).toContain('acting={acting === row.index || (isActive && pinned)}')
  })

  it('the idle fade cannot hide a pinned tag out from under the user', () => {
    expect(rail).toContain('!lineageOpen && !pinned')
  })

  it('LIVE is the way out of a pin, and always obeyed', () => {
    expect(rail).toContain("nextFocus(state, { kind: 'live', at: Date.now() })")
  })
})
