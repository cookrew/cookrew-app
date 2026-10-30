// THE LIVE TERMINAL SCROLLS HERE, NOT IN THE PANE (renderer/live-scroll.ts):
// the wheel moves local history at once; before history arrives a scroll is
// held for it; a backend with no history keeps the old pane scroll; a seed
// that lands while the reader is scrolled up is dropped; background reseeds
// follow the pane's history size, not every repaint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { SEED_OSC, installLocalScroll, wheelRows } from '../src/renderer/src/live-scroll'

function fakeTerm() {
  let wheel: ((e: WheelEvent) => boolean) | null = null
  let osc: ((data: string) => boolean) | null = null
  const active = { type: 'normal' as 'normal' | 'alternate', viewportY: 0, baseY: 0 }
  const term = {
    rows: 40,
    element: undefined,
    buffer: { active },
    parser: { registerOscHandler: (id: number, fn: (d: string) => boolean) => { expect(id).toBe(SEED_OSC); osc = fn; return { dispose: () => { osc = null } } } },
    attachCustomWheelEventHandler: (fn: (e: WheelEvent) => boolean) => { wheel = fn },
    scrollLines: vi.fn((n: number) => { active.viewportY = Math.min(active.baseY, Math.max(0, active.viewportY + n)) })
  }
  const spin = (deltaY: number) => wheel!({ deltaY, deltaMode: 0, preventDefault: () => undefined } as unknown as WheelEvent)
  /** A seed for `nonce` parsed: `base` lines of history now in the scrollback, viewer at the bottom. */
  const land = (nonce: string, base: number) => { active.baseY = base; active.viewportY = base; osc!(`cookrew-seed;${nonce}`) }
  return { term: term as unknown as Terminal, active, spin, land, scrollLines: term.scrollLines }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('document', { visibilityState: 'visible' })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('wheelRows', () => {
  it('turns pixels, lines and pages into rows, carrying the remainder', () => {
    expect(wheelRows({ deltaY: 40, deltaMode: 0 }, 17, 40, 0)).toEqual({ rows: 2, carry: 6 })
    expect(wheelRows({ deltaY: 11, deltaMode: 0 }, 17, 40, 6)).toEqual({ rows: 1, carry: 0 })
    expect(wheelRows({ deltaY: -3, deltaMode: 1 }, 17, 40, 0)).toEqual({ rows: -3, carry: 0 })
    expect(wheelRows({ deltaY: 1, deltaMode: 2 }, 17, 40, 0)).toEqual({ rows: 40, carry: 0 })
  })
})

describe('installLocalScroll', () => {
  it('holds a scroll until the first history lands, then scrolls locally at once', async () => {
    const f = fakeTerm()
    const nonces: string[] = []
    const scroll = installLocalScroll(f.term, { seed: async (n) => (nonces.push(n), true), live: () => true, lines: 1000, refreshMs: 3000 })
    scroll.onLive()
    expect(nonces).toHaveLength(1)
    expect(f.spin(-170)).toBe(false) // not sent to the pane
    expect(f.scrollLines).not.toHaveBeenCalled()
    f.land(nonces[0], 500)
    expect(f.scrollLines).toHaveBeenCalledWith(-10)
    expect(f.spin(-34)).toBe(false)
    expect(f.scrollLines).toHaveBeenLastCalledWith(-2)
    scroll.dispose()
  })

  it('a backend with no history leaves the wheel to the pane, as before', async () => {
    const f = fakeTerm()
    const scroll = installLocalScroll(f.term, { seed: async () => false, live: () => true, lines: 1000, refreshMs: 3000 })
    scroll.onLive()
    await Promise.resolve()
    expect(f.spin(-100)).toBe(true)
    scroll.dispose()
  })

  it('in chat, or on an alternate screen, the wheel is not taken', () => {
    const f = fakeTerm()
    let live = false
    const scroll = installLocalScroll(f.term, { seed: async () => true, live: () => live, lines: 1000, refreshMs: 3000 })
    expect(f.spin(-100)).toBe(true)
    live = true
    f.active.type = 'alternate'
    expect(f.spin(-100)).toBe(true)
    scroll.dispose()
  })

  it('drops a seed that arrives while the reader is scrolled up, and keeps it at the bottom', async () => {
    const f = fakeTerm()
    const nonces: string[] = []
    const scroll = installLocalScroll(f.term, { seed: async (n) => (nonces.push(n), true), live: () => true, lines: 1000, refreshMs: 3000 })
    scroll.onLive()
    f.land(nonces[0], 500)
    const seed = `\x1b[2J\x1b[3J\x1b[H...\x1b]777;cookrew-seed;later\x07`
    expect(scroll.admit(seed)).toBe(true) // at the bottom: welcome
    f.spin(-170)
    expect(scroll.admit(seed)).toBe(false) // scrolled up: their place stays
    expect(scroll.admit('ordinary output')).toBe(true)
    scroll.dispose()
  })

  it('reseeds in the background only when the pane history grew, or a replay wiped it', async () => {
    const f = fakeTerm()
    let size = 100
    const nonces: string[] = []
    const scroll = installLocalScroll(f.term, { seed: async (n) => (nonces.push(n), true), live: () => true, lines: 1000, refreshMs: 3000, history: () => size })
    scroll.onLive()
    f.land(nonces[0], 500)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(nonces).toHaveLength(1) // a spinner repainting is not new history
    size = 140
    await vi.advanceTimersByTimeAsync(3000)
    expect(nonces).toHaveLength(2)
    f.land(nonces[1], 540)
    f.active.baseY = 0 // a resize replay cleared the scrollback
    f.active.viewportY = 0
    await vi.advanceTimersByTimeAsync(3000)
    expect(nonces).toHaveLength(3)
    scroll.dispose()
  })
})
