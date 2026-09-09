// WHAT 1,048 ROWS COST THE OVERLAY (D6, T5 QA 2026-09-07).
//
// THE DEFECT. The companion tab froze twice with the busiest card's overlay
// open. TranscriptView is "identity-space virtualized" in its scroll GEOMETRY
// and not in its DOM: every identity is a real div, so a 1,048-row card mounts
// 1,048 of them. Three costs came off that, and each is bounded here:
//
//   1. THE PER-RENDER REBUILD. `spaceIds` (a Set, then a sort), `loadedMap`
//      and `loadedSet` were rebuilt on EVERY render, and the overlay
//      re-renders on every scroll frame, tail tick and rail hover.
//   2. THE REF CHURN. An inline `ref={(node) => …}` per row is a NEW callback
//      identity per render, so React detached and reattached all 1,048 —
//      2,096 callback invocations per render.
//   3. THE LAYOUT STORM. Every row is observed by one ResizeObserver, and one
//      estimate refinement rewrites every placeholder's inline height; each
//      callback read scrollHeight and clientHeight, forcing a synchronous
//      layout. A thousand of those in one batch is the freeze.
//
// House pattern: no jsdom, no @testing-library (neither is a dependency).
// renderToStaticMarkup runs the component body, which is where (1) and (2)
// live; (3) is an effect and is asserted at its source, as the rail's own
// parity guards do.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { transcriptIdentitySpace } from '../src/renderer/src/TranscriptView'
import type { TraceBlock } from '../src/renderer/src/transcript'

/** The owner's busiest card. */
const ROWS = 1048

/**
 * The budget, stated — and stated in two parts, because a wall clock alone is
 * not a gate on a machine that runs 500 test files in a worker pool. The same
 * render measured 25 ms alone and 2,309 ms beside a typecheck.
 *
 * THE SHAPE is the real assertion: 1,048 rows may cost no more than SLOPE
 * times what 128 rows cost, on the same machine, in the same run. A render
 * that reintroduced a per-row Set/sort or a per-row measurement is quadratic
 * and cannot fit under it however fast the box is. Eight-fold rows for at most
 * twelve-fold time leaves room for the fixed cost 128 rows also pay.
 *
 * THE CEILING is the second half: a person calls it a freeze somewhere around
 * a second, so an absolute failure still trips even if the ratio holds.
 */
const RENDER_SLOPE = 12
const RENDER_CEILING_MS = 2000
/** Same reasoning as RENDER_SLOPE: 8x the rows for a Set-plus-sort is ~9.6x
 *  the work; 16x leaves room for load and for the fixed cost the small size
 *  also pays. Quadratic would be ~64x. */
const SPACE_SLOPE = 16

const block = (index: number): TraceBlock => ({
  index,
  id: `u${index}`,
  prompt: `prompt ${index}`,
  reply: `reply ${index}`,
  activity: [],
  startedAt: index,
  endedAt: index
})

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

/** A pager that answers nothing: the render under test draws placeholders. */
const idlePager = {
  window: async () => ({ blocks: [], render: 'replay' as const }),
  around: async () => ({ blocks: [], render: 'replay' as const }),
  after: async () => ({ blocks: [], render: 'replay' as const })
}

async function renderRows(count: number): Promise<{ markup: string; ms: number }> {
  stubDesktop()
  vi.resetModules()
  const { TranscriptView } = await import('../src/renderer/src/TranscriptView')
  const identities = Array.from({ length: count }, (_, at) => at + 1)
  const started = performance.now()
  const markup = renderToStaticMarkup(
    <TranscriptView
      terminalId="t1"
      pager={idlePager as never}
      total={count}
      identities={identities}
      titleMode="conclusion"
      selectedIndex={null}
      jumpToken={0}
      clipRows={null}
    >
      <div />
    </TranscriptView>
  )
  return { markup, ms: performance.now() - started }
}

describe('the overlay with 1,048 rows', () => {
  it('costs LINEARLY in the rows, and never a freeze', async () => {
    // Warm the module graph and the JIT, then measure both sizes back to back
    // so machine load lands on each of them equally.
    await renderRows(8)
    const small = await renderRows(128)
    const { markup, ms } = await renderRows(ROWS)
    expect(markup.match(/data-checkpoint="/g) ?? []).toHaveLength(ROWS)
    expect(markup).toContain('data-checkpoint="1"')
    expect(markup).toContain(`data-checkpoint="${ROWS}"`)
    // 8.2x the rows for at most 12x the time — quadratic would be ~67x.
    expect(ms).toBeLessThan(Math.max(small.ms, 1) * RENDER_SLOPE)
    expect(ms).toBeLessThan(RENDER_CEILING_MS)
  })

  it('the identity space is linear in the rows, not quadratic', async () => {
    const spaceMs = (count: number): number => {
      const identities = Array.from({ length: count }, (_, at) => at + 1)
      const loaded = Array.from({ length: 60 }, (_, at) => block(Math.max(1, count - 60 + at)))
      const started = performance.now()
      for (let n = 0; n < 40; n += 1) transcriptIdentitySpace(identities, loaded)
      return performance.now() - started
    }
    spaceMs(128) // warm
    const small = spaceMs(131)
    const big = spaceMs(ROWS)
    expect(
      transcriptIdentitySpace(
        Array.from({ length: ROWS }, (_, at) => at + 1),
        []
      )
    ).toHaveLength(ROWS)
    expect(big).toBeLessThan(Math.max(small, 0.5) * SPACE_SLOPE)
  })
})

describe('the three costs, bounded at their source', () => {
  const source = readFileSync(
    join(__dirname, '../src/renderer/src/TranscriptView.tsx'),
    'utf8'
  ).replace(/\s+/g, ' ')

  it('the identity space and the loaded maps are memoised, not rebuilt', () => {
    expect(source).toContain('useMemo(() => new Map(blocks.map((b) => [b.index, b])), [blocks])')
    expect(source).toContain('useMemo(() => new Set(blocks.map((b) => b.index)), [blocks])')
    expect(source).toContain('transcriptIdentitySpace(identities, blocks), [identities, blocks]')
  })

  it('each row keeps ONE ref callback, so a re-render moves no refs', () => {
    expect(source).toContain('ref={rowRef(id)}')
    // The inline closure this replaced would be a new identity every render.
    expect(source).not.toContain('ref={(node) => { if (node) blockRefs.current.set(id, node)')
  })

  it('the stick pass is coalesced to one frame, not one per observed row', () => {
    expect(source).toContain('const ro = new ResizeObserver(stick)')
    expect(source).toContain('frame = requestAnimationFrame(')
    expect(source).toContain('if (frame !== null) return')
  })

  // THE ENGINE-LEVEL BOUND STAYS ON THE PHONE, and this says why so nobody
  // reaches for it again. Unscoped, `content-visibility` BLANKED the desktop
  // transcript (7894903, "render heavy transcripts on desktop") and has a
  // permanent guard of its own in tests/transcript-paint-scope.test.ts. D6
  // tried it, hit that guard, and put it back: the desktop's share of the cost
  // is bounded in the component, by the three assertions above.
  it('leaves the engine-level rescue scoped to the phone, where it is proven', () => {
    const css = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')
    expect(css).toMatch(
      /body\.cookrew-mobile \.ctx-block,\s*body\.cookrew-mobile \.ctx-placeholder\s*\{[^}]*content-visibility:\s*auto/s
    )
    expect(css).not.toMatch(/\n\.ctx-block,\s*\n\.ctx-placeholder\s*\{[^}]*content-visibility/s)
  })
})
