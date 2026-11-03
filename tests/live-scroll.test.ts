// THE LIVE TERMINAL SCROLLS HERE, NOT IN THE PANE (renderer/live-scroll.ts):
// the wheel moves local history at once; before history arrives a scroll is
// held for it; a backend with no history keeps the old pane scroll; a seed
// that lands while the reader is scrolled up is dropped; background reseeds
// follow the pane's history size, not every repaint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { RESIZE_ASK_MS, RESIZE_TAKE_MS, SEED_OSC, installLocalScroll, seedCols, wheelRows } from '../src/renderer/src/live-scroll'

function fakeTerm() {
  let wheel: ((e: WheelEvent) => boolean) | null = null
  let osc: ((data: string) => boolean) | null = null
  let onResize: ((size: { cols: number; rows: number }) => void) | null = null
  const active = { type: 'normal' as 'normal' | 'alternate', viewportY: 0, baseY: 0 }
  const term = {
    cols: 49,
    rows: 40,
    onResize: (fn: (size: { cols: number; rows: number }) => void) => { onResize = fn; return { dispose: () => { onResize = null } } },
    element: undefined,
    buffer: { active },
    parser: { registerOscHandler: (id: number, fn: (d: string) => boolean) => { expect(id).toBe(SEED_OSC); osc = fn; return { dispose: () => { osc = null } } } },
    attachCustomWheelEventHandler: (fn: (e: WheelEvent) => boolean) => { wheel = fn },
    scrollLines: vi.fn((n: number) => { active.viewportY = Math.min(active.baseY, Math.max(0, active.viewportY + n)) })
  }
  const spin = (deltaY: number) => wheel!({ deltaY, deltaMode: 0, preventDefault: () => undefined } as unknown as WheelEvent)
  /** A seed for `nonce` parsed: `base` lines of history now in the scrollback, viewer at the bottom. */
  const land = (nonce: string, base: number) => { active.baseY = base; active.viewportY = base; osc!(`cookrew-seed;${nonce}`) }
  /** The grid took a new size (a fit, or another viewer's size adopted). */
  const resize = (cols: number, rows: number) => { term.cols = cols; term.rows = rows; onResize!({ cols, rows }) }
  return { term: term as unknown as Terminal, active, spin, land, resize, scrollLines: term.scrollLines }
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

  it('a backend with no history leaves the wheel to the pane, as before — after three refusals, not one', async () => {
    const f = fakeTerm()
    let calls = 0
    const scroll = installLocalScroll(f.term, { seed: async () => (calls++, false), live: () => true, lines: 1000, refreshMs: 3000 })
    scroll.onLive()
    await Promise.resolve()
    // One refusal may be "not yet" (a phone stream not named): the wheel still waits for history.
    expect(f.spin(-100)).toBe(false)
    await Promise.resolve()
    scroll.onLive()
    await Promise.resolve()
    expect(calls).toBe(3)
    expect(f.spin(-100)).toBe(true)
    scroll.dispose()
  })

  it('in chat the wheel is not taken; on the alternate screen (history lost) it waits for history', () => {
    const f = fakeTerm()
    let live = false
    const nonces: string[] = []
    const scroll = installLocalScroll(f.term, { seed: async (n) => (nonces.push(n), true), live: () => live, lines: 1000, refreshMs: 3000 })
    expect(f.spin(-100)).toBe(true)
    live = true
    f.active.type = 'alternate'
    expect(f.spin(-170)).toBe(false)
    expect(nonces).toHaveLength(1)
    f.active.type = 'normal'
    f.land(nonces[0], 300)
    expect(f.scrollLines).toHaveBeenCalledWith(-10)
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

  it('a new width asks again once the reprint has landed, and once more if the history moved', async () => {
    const f = fakeTerm()
    let size = 100
    const nonces: string[] = []
    // A long refresh, so only the width change can be asking.
    const scroll = installLocalScroll(f.term, { seed: async (n) => (nonces.push(n), true), live: () => true, lines: 400, refreshMs: 60_000, history: () => size })
    scroll.onLive()
    f.land(nonces[0], 500)
    f.resize(98, 22) // the phone turned
    f.resize(99, 22) // ...and the fit settled: one round of asks, from the last change
    await vi.advanceTimersByTimeAsync(RESIZE_ASK_MS[0] - 1)
    expect(nonces).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(nonces).toHaveLength(2)
    f.land(nonces[1], 520)
    size = 180 // Claude Code was still printing at the new width
    await vi.advanceTimersByTimeAsync(RESIZE_ASK_MS[1] - RESIZE_ASK_MS[0])
    expect(nonces).toHaveLength(3)
    scroll.dispose()
  })

  it('a new height alone is not a new width: no asks', async () => {
    const f = fakeTerm()
    const nonces: string[] = []
    const scroll = installLocalScroll(f.term, { seed: async (n) => (nonces.push(n), true), live: () => true, lines: 400, refreshMs: 60_000, history: () => 100 })
    scroll.onLive()
    f.land(nonces[0], 500)
    f.resize(49, 30) // a toolbar slid away
    await vi.advanceTimersByTimeAsync(RESIZE_ASK_MS[1] + 100)
    expect(nonces).toHaveLength(1)
    scroll.dispose()
  })

  it('after a new width the seed is taken even from a reader scrolled up — for a while', async () => {
    const f = fakeTerm()
    const nonces: string[] = []
    const scroll = installLocalScroll(f.term, { seed: async (n) => (nonces.push(n), true), live: () => true, lines: 400, refreshMs: 60_000 })
    scroll.onLive()
    f.land(nonces[0], 500)
    f.spin(-170)
    const seed = `\x1b[2J\x1b[3J\x1b[H...\x1b]777;cookrew-seed;wide\x07`
    expect(scroll.admit(seed)).toBe(false)
    f.resize(99, 40)
    expect(scroll.admit(seed)).toBe(true) // their place was at the old width
    await vi.advanceTimersByTimeAsync(RESIZE_TAKE_MS)
    f.active.viewportY = 100
    expect(scroll.admit(seed)).toBe(false) // settled: a reader's place is theirs again
    scroll.dispose()
  })

  it('in chat a new width asks nothing (the live view seeds when it comes up)', async () => {
    const f = fakeTerm()
    const nonces: string[] = []
    const scroll = installLocalScroll(f.term, { seed: async (n) => (nonces.push(n), true), live: () => false, lines: 400, refreshMs: 60_000 })
    f.resize(99, 40)
    await vi.advanceTimersByTimeAsync(RESIZE_ASK_MS[1] + 100)
    expect(nonces).toHaveLength(0)
    scroll.dispose()
  })

  it('never writes a seed built at another width, and asks again at this one', async () => {
    // The owner's blank row under every line: a seed built while a widen
    // passed the pane through cols+2, written into a grid two columns narrower.
    const f = fakeTerm() // 49 columns
    const nonces: string[] = []
    const scroll = installLocalScroll(f.term, { seed: async (n) => (nonces.push(n), true), live: () => true, lines: 400, refreshMs: 3000 })
    scroll.onLive()
    expect(nonces).toHaveLength(1)
    expect(scroll.admit(`\x1b[2J...\x1b]777;cookrew-seed;${nonces[0]};51\x07`)).toBe(false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(nonces).toHaveLength(2) // asked again at once, not after the refresh
    expect(scroll.admit(`\x1b[2J...\x1b]777;cookrew-seed;${nonces[1]};49\x07`)).toBe(true)
    f.land(nonces[1], 300)
    // A marker that names no width (an older main) is written as before.
    expect(scroll.admit(`\x1b[2J...\x1b]777;cookrew-seed;old\x07`)).toBe(true)
    scroll.dispose()
  })

  it('reads the width from the marker, and the nonce without it', () => {
    expect(seedCols('x\x1b]777;cookrew-seed;n1;177\x07')).toBe(177)
    expect(seedCols('x\x1b]777;cookrew-seed;n1\x07')).toBeNull()
    expect(seedCols('no marker')).toBeNull()
  })

  it('a history the grid reflowed while the view was away is asked for again when it is back', async () => {
    // Another viewer took the pane's size while this one sat in chat: xterm
    // reflowed the seeded rows into the new width, padding split and joined.
    const f = fakeTerm()
    let live = true
    const nonces: string[] = []
    const scroll = installLocalScroll(f.term, { seed: async (n) => (nonces.push(n), true), live: () => live, lines: 400, refreshMs: 3000, history: () => 100 })
    scroll.onLive()
    f.land(nonces[0], 500)
    live = false
    f.resize(99, 40)
    await vi.advanceTimersByTimeAsync(RESIZE_ASK_MS[1] + 3000)
    expect(nonces).toHaveLength(1)
    live = true
    await vi.advanceTimersByTimeAsync(3000)
    expect(nonces).toHaveLength(2)
    scroll.dispose()
  })
})
