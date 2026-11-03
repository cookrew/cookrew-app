// THE LAYERS RIDE THE MOTION ONLY (renderer zoom/zoom-rest.ts, zoom-frame.ts ·
// put): the root carries `data-moving` while the frame loop runs and drops it
// a moment after it settles, and zoom.css takes every compositor hint away
// without it; a part at opacity 0 is hidden, so it is never painted. Held at
// rest, the hints kept the tiles of the deepest dive, and Chromium ran out of
// tile memory and left parts of the crew undrawn (owner, 2026-11-01).
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRestFlag, REST_MS } from '../src/renderer/src/zoom/zoom-rest'
import { put } from '../src/renderer/src/zoom/zoom-frame'

const fakeEl = (): HTMLElement => ({ dataset: {} as DOMStringMap, style: {} as CSSStyleDeclaration }) as HTMLElement

describe('the rest flag', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is up while the loop moves and goes a moment after it settles', () => {
    const el = fakeEl()
    const flag = createRestFlag(() => el)
    flag.moving()
    expect(el.dataset.moving).toBe('true')
    flag.settled()
    vi.advanceTimersByTime(REST_MS - 1)
    expect(el.dataset.moving).toBe('true')
    vi.advanceTimersByTime(1)
    expect(el.dataset.moving).toBeUndefined()
  })

  it('stays up when the move goes on within the grace (a snap after a click)', () => {
    const el = fakeEl()
    const flag = createRestFlag(() => el)
    flag.moving()
    flag.settled()
    vi.advanceTimersByTime(REST_MS / 2)
    flag.moving()
    vi.advanceTimersByTime(REST_MS * 2)
    expect(el.dataset.moving).toBe('true')
  })

  it('a settled loop that never moved sets nothing, and a disposed one drops nothing late', () => {
    const el = fakeEl()
    const flag = createRestFlag(() => el)
    flag.settled()
    vi.advanceTimersByTime(REST_MS * 2)
    expect(el.dataset.moving).toBeUndefined()
    flag.moving()
    flag.settled()
    flag.dispose()
    vi.advanceTimersByTime(REST_MS * 2)
    expect(el.dataset.moving).toBe('true')
  })

  it('zoom.css drops every hint in the overview without the flag', () => {
    const css = readFileSync('src/renderer/src/zoom/zoom.css', 'utf8')
    expect(css).toMatch(/\.zv-root:not\(\[data-moving\]\) \.zv-overview \* \{\s*will-change: auto;/)
  })
})

describe('a part at opacity 0', () => {
  it('is hidden as well as unpressable, and shown again when it comes back', () => {
    const el = fakeEl()
    put(el, 'translate(1px, 2px)', 0)
    expect(el.style.visibility).toBe('hidden')
    expect(el.style.pointerEvents).toBe('none')
    put(el, null, 0.02)
    expect(el.style.visibility).toBe('')
    expect(el.style.pointerEvents).toBe('none')
    put(el, null, 1)
    expect(el.style.visibility).toBe('')
    expect(el.style.pointerEvents).toBe('')
    expect(el.style.transform).toBe('translate(1px, 2px)')
  })

  it('a value that rounds to zero counts as zero', () => {
    const el = fakeEl()
    put(el, null, 0.0004)
    expect(el.style.visibility).toBe('hidden')
  })
})
