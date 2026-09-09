import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LazyTerminalAttachments } from '../src/main/lazy-terminal'

/**
 * A phone page left open for hours went black (2026-09-04): iOS reaps a
 * backgrounded tab's connections, the SSE close released the last viewer,
 * and the mirror was disposed ON THE SPOT. Coming back booted a FRESH
 * mirror whose replay frame is an empty screen — and a herdr agent sitting
 * idle emits zero bytes, so the live pane stayed black for good.
 *
 * The mirror now LINGERS after its last viewer leaves: a phone that comes
 * back within the window finds the same session with its screen intact, and
 * a page that is genuinely gone still releases the PTY, just later.
 */

function harness(opts: { working?: boolean; resident?: (id: string) => boolean } = {}): {
  lazy: LazyTerminalAttachments
  detached: string[]
  attached: string[]
  run: () => void
  pending: () => number
} {
  const detached: string[] = []
  const attached: string[] = []
  const queue = new Map<number, () => void>()
  let next = 1
  const lazy = new LazyTerminalAttachments({
    attach: (id) => {
      attached.push(id)
      return true
    },
    detach: (id) => void detached.push(id),
    isWorking: () => opts.working === true,
    watchWorking: () => undefined,
    resident: opts.resident ?? (() => true),
    lingerMax: 3,
    schedule: (run) => {
      const id = next++
      queue.set(id, run)
      return id
    },
    cancel: (handle) => void queue.delete(handle as number)
  })
  return {
    lazy,
    detached,
    attached,
    run: () => {
      const entries = [...queue.entries()]
      queue.clear()
      for (const [, run] of entries) run()
    },
    pending: () => queue.size
  }
}

describe('the mirror lingers past its last viewer', () => {
  it('does not detach the instant a viewer leaves', () => {
    const h = harness()
    h.lazy.acquire('t1')
    h.lazy.release('t1')
    expect(h.detached).toEqual([])
    expect(h.pending()).toBe(1)
  })

  it('detaches once the window passes with nobody watching', () => {
    const h = harness()
    h.lazy.acquire('t1')
    h.lazy.release('t1')
    h.run()
    expect(h.detached).toEqual(['t1'])
  })

  it('a viewer returning inside the window keeps the SAME mirror — no re-boot', () => {
    // The whole point: the screen the phone comes back to is the screen it
    // left, not an empty one nobody will ever repaint.
    const h = harness()
    h.lazy.acquire('t1')
    h.lazy.release('t1')
    h.lazy.acquire('t1')
    h.run()
    expect(h.detached).toEqual([])
    expect(h.lazy.viewerCount('t1')).toBe(1)
  })

  it('a re-release re-arms the window rather than stacking timers', () => {
    const h = harness()
    h.lazy.acquire('t1')
    h.lazy.release('t1')
    h.lazy.acquire('t1')
    h.lazy.release('t1')
    expect(h.pending()).toBe(1)
    h.run()
    expect(h.detached).toEqual(['t1'])
  })

  it('a working agent is never detached when its window comes due', () => {
    const h = harness({ working: true })
    h.lazy.acquire('t1')
    h.lazy.release('t1')
    h.run()
    expect(h.detached).toEqual([])
  })

  it('reconsider still releases a finished agent nobody is watching', () => {
    const h = harness()
    h.lazy.reconsider('t1')
    h.run()
    expect(h.detached).toEqual(['t1'])
  })
})

describe('the linger keeps only what it can keep', () => {
  it('a terminal with no mirror takes the old immediate path', () => {
    // trim() is reached for every terminal at boot and on every status
    // event; arming a window for one with nothing to protect would defer
    // its file-watch and turn-tracker release fleet-wide, for nothing.
    const h = harness({ resident: () => false })
    h.lazy.reconsider('t1')
    expect(h.detached).toEqual(['t1'])
    expect(h.pending()).toBe(0)
  })

  it('caps the mirrors it holds at once — the oldest window closes early', () => {
    const h = harness()
    for (const id of ['a', 'b', 'c', 'd']) {
      h.lazy.acquire(id)
      h.lazy.release(id)
    }
    // lingerMax 3: 'a' had its chance and is let go now, not in 45s.
    expect(h.detached).toEqual(['a'])
    h.run()
    expect(h.detached).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a retired terminal forgets its window — a reborn id inherits nothing', () => {
    const h = harness()
    h.lazy.acquire('t1')
    h.lazy.release('t1')
    h.lazy.forget('t1')
    h.run()
    expect(h.detached).toEqual([])
    expect(h.lazy.viewerCount('t1')).toBe(0)
  })
})

describe('a reconnect repaints, because nothing remounted to do it', () => {
  it('kicks on every hello after the first', () => {
    // Past the linger the mirror IS rebuilt, and its replay frame is an
    // empty screen an idle herdr agent never repaints. The mount-time kick
    // cannot help a stream that reconnected under a live overlay.
    const overlay = readFileSync(
      path.join(__dirname, '..', 'src/renderer/src', 'TerminalOverlay.tsx'),
      'utf8'
    )
    const start = overlay.indexOf('const repaintKick')
    expect(start).toBeGreaterThan(-1)
    const attach = overlay.indexOf('cookrew().ptyAttach(', start)
    expect(attach).toBeGreaterThan(-1)
    const hello = overlay.slice(attach, overlay.indexOf('const inputSub', attach))
    expect(hello).toContain('helloSeen')
    expect(hello).toContain('repaintKick')
    // COALESCED: every kick resizes the SHARED mirror and repaints it for
    // every other viewer, and a flapping link reconnects several times a
    // second (this file's own history: a burst of 4-13 identical resizes).
    expect(hello).toContain('lastKickAt')
    expect(hello).toContain('rekickTimer')
  })
})
