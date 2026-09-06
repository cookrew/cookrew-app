// The LOD hook re-renders its host on every viewport frame. What keeps that
// from re-rendering both overlay layers (and every offscreen-hosted browser
// view under them) sixty times a second is that the hook hands back the SAME
// layout object until something a consumer reads has changed. sameLayout is
// the rule for "has changed"; these pin it.
import { describe, expect, it } from 'vitest'
import { sameLayout, type LodLayout } from '../src/renderer/src/zoom-lod'

const rect = (x: number, y = 0): { x: number; y: number; width: number; height: number } => ({
  x,
  y,
  width: 100,
  height: 80
})

const layout = (over: Partial<LodLayout> = {}): LodLayout => ({
  activeIds: new Set(['a']),
  rects: { a: rect(0), b: rect(500) },
  primaryId: 'a',
  ...over
})

describe('sameLayout — when a new frame may reuse the last layout', () => {
  it('reuses when nothing an overlay reads has moved', () => {
    expect(sameLayout(layout(), layout())).toBe(true)
  })

  it('does NOT reuse when the winner changes', () => {
    expect(sameLayout(layout(), layout({ primaryId: 'b' }))).toBe(false)
    expect(sameLayout(layout(), layout({ primaryId: null }))).toBe(false)
  })

  it('does NOT reuse when the active set changes', () => {
    expect(sameLayout(layout(), layout({ activeIds: new Set(['a', 'b']) }))).toBe(false)
    expect(sameLayout(layout(), layout({ activeIds: new Set(['b']), primaryId: 'a' }))).toBe(false)
    expect(sameLayout(layout(), layout({ activeIds: new Set() }))).toBe(false)
  })

  it('does NOT reuse when an ACTIVE rect moves — the open overlay must track a pan', () => {
    expect(sameLayout(layout(), layout({ rects: { a: rect(1), b: rect(500) } }))).toBe(false)
    expect(sameLayout(layout(), layout({ rects: { a: { ...rect(0), height: 81 }, b: rect(500) } }))).toBe(false)
  })

  it('DOES reuse when only an inactive rect moves — nobody reads those', () => {
    // This is the whole point: during a zoom animation every thumbnail's rect
    // changes every frame, and none of them is an overlay.
    expect(sameLayout(layout(), layout({ rects: { a: rect(0), b: rect(501) } }))).toBe(true)
    expect(sameLayout(layout(), layout({ rects: { a: rect(0) } }))).toBe(true)
  })

  it('treats a missing active rect as a change', () => {
    expect(sameLayout(layout(), layout({ rects: { b: rect(500) } }))).toBe(false)
  })

  it('an empty layout is the same as another empty layout', () => {
    const empty = (): LodLayout => ({ activeIds: new Set(), rects: { z: rect(9) }, primaryId: null })
    expect(sameLayout(empty(), empty())).toBe(true)
  })
})
