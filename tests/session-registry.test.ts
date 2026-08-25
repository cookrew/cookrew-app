// The registry that replaced wave C's serviceState machine.
//
// a5a1bc6 shipped `hot | dormant | parked` — a STORED intent someone had to
// unset. Two flags leaked by a failed rollback cost O(attached × panes)
// forever and read as ten unrelated bugs (/api/activity 190ms → 6.85s, herdr
// at 74% CPU); the owner reverted the lot in ef5e13c. The post-mortem's
// verdict was that a model whose dominant failure mode is FORGETTING is the
// wrong model.
//
// So liveness here is DERIVED, never set: a workspace is live iff a window is
// bound to it, a slug subscriber is reading it, or work is in flight. What
// these tests pin is the absence of the flag — that no caller can retain a
// session, and that a session with nothing true about it costs nothing.

import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry, DRAIN_DEBOUNCE_MS } from '../src/main/session-registry'

const NOW = 1_800_000_000_000

/** Mutable liveness facts, the way the real sources are: read, never stored. */
function facts() {
  return {
    windows: new Map<string, number>(),
    subscribers: new Map<string, number>(),
    work: new Map<string, number>()
  }
}

function registry(over: Partial<ConstructorParameters<typeof SessionRegistry>[0]> = {}) {
  const f = facts()
  let clock = NOW
  const reg = new SessionRegistry({
    boundWindows: (id) => f.windows.get(id) ?? 0,
    subscribers: (id) => f.subscribers.get(id) ?? 0,
    inFlightWork: (id) => f.work.get(id) ?? 0,
    hydrate: (id) => ({ id, nodes: [] }),
    release: () => undefined,
    now: () => clock,
    ...over
  })
  const tick = (ms: number): void => {
    clock += ms
  }
  /**
   * The drain is a POLLER, so it takes two passes: one to observe that a
   * session went dead (starting its clock) and one after the debounce to
   * release it. Nothing observes the exact instant liveness fell — that would
   * require a notification, which is the coupling this design avoids.
   */
  const poll = (ms: number): void => {
    reg.drainTick()
    tick(ms)
    reg.drainTick()
  }
  return { reg, f, tick, poll }
}

describe('derived liveness — there is no flag to leak', () => {
  it('exposes no way to mark a session live', () => {
    const { reg } = registry()
    // The wave-C API surface. Its absence is the point of this module.
    const surface = reg as unknown as Record<string, unknown>
    expect(surface.setState).toBeUndefined()
    expect(surface.markHot).toBeUndefined()
    expect(surface.open).toBeUndefined()
    expect(surface.close).toBeUndefined()
  })

  it('a workspace with no window, no subscriber and no work is not live', () => {
    const { reg } = registry()
    expect(reg.isLive('ws')).toBe(false)
  })

  it('any one of the three facts makes it live', () => {
    const { reg, f } = registry()
    f.windows.set('a', 1)
    f.subscribers.set('b', 1)
    f.work.set('c', 1)
    expect(reg.isLive('a')).toBe(true)
    expect(reg.isLive('b')).toBe(true)
    expect(reg.isLive('c')).toBe(true)
  })

  it('liveness follows the facts back DOWN without anyone unsetting it', () => {
    const { reg, f } = registry()
    f.work.set('ws', 1)
    expect(reg.isLive('ws')).toBe(true)
    f.work.set('ws', 0) // the dispatch settled; nobody told the registry
    expect(reg.isLive('ws')).toBe(false)
  })
})

describe('materialisation', () => {
  it('hydrates on first get and returns the same object after', () => {
    const hydrate = vi.fn((id: string) => ({ id, nodes: [] }))
    const { reg, f } = registry({ hydrate })
    f.windows.set('ws', 1)
    const first = reg.get('ws')
    const second = reg.get('ws')
    expect(first).toBe(second)
    expect(hydrate).toHaveBeenCalledTimes(1)
  })

  it('a hydrate that throws retains NOTHING', () => {
    // Wave C's leak was a failed rollback that left workspaces marked hot.
    // A boot path that dies must cost zero, not a permanent tax.
    const { reg, f } = registry({
      hydrate: () => {
        throw new Error('corrupt workspace file')
      }
    })
    f.windows.set('ws', 1)
    expect(() => reg.get('ws')).toThrow('corrupt workspace file')
    expect(reg.resident()).toEqual([])
    expect(reg.residentCount()).toBe(0)
  })

  it('counts only what it actually holds', () => {
    const { reg, f } = registry()
    f.windows.set('a', 1)
    f.windows.set('b', 1)
    reg.get('a')
    expect(reg.residentCount()).toBe(1)
    reg.get('b')
    expect(reg.residentCount()).toBe(2)
  })
})

describe('drain — automatic, debounced, self-cancelling', () => {
  it('releases a resident session once nothing is true about it', () => {
    const release = vi.fn()
    const { reg, f, poll } = registry({ release })
    f.windows.set('ws', 1)
    reg.get('ws')

    f.windows.set('ws', 0) // window closed
    poll(DRAIN_DEBOUNCE_MS + 1)

    expect(release).toHaveBeenCalledWith('ws', expect.anything())
    expect(reg.resident()).toEqual([])
  })

  it('does not release before the debounce elapses', () => {
    const release = vi.fn()
    const { reg, f, poll } = registry({ release })
    f.windows.set('ws', 1)
    reg.get('ws')

    f.windows.set('ws', 0)
    poll(DRAIN_DEBOUNCE_MS - 1)

    expect(release).not.toHaveBeenCalled()
    expect(reg.residentCount()).toBe(1)
  })

  it('a fact returning within the debounce cancels the drain', () => {
    // Switching away and straight back must not tear down and rebuild.
    const release = vi.fn()
    const { reg, f, tick } = registry({ release })
    f.windows.set('ws', 1)
    reg.get('ws')

    f.windows.set('ws', 0)
    reg.drainTick()               // observed dead
    tick(DRAIN_DEBOUNCE_MS - 10)
    f.windows.set('ws', 1)        // came back before the debounce elapsed
    tick(1000)
    reg.drainTick()

    expect(release).not.toHaveBeenCalled()
    expect(reg.residentCount()).toBe(1)
  })

  it('never releases a session that still has in-flight work', () => {
    // The §11 promise: orchestration in the workspace you looked away from
    // keeps running. Work outlives attention, always.
    const release = vi.fn()
    const { reg, f, poll } = registry({ release })
    f.windows.set('ws', 1)
    f.work.set('ws', 2)
    reg.get('ws')

    f.windows.set('ws', 0) // looked away
    poll(DRAIN_DEBOUNCE_MS * 10)

    expect(release).not.toHaveBeenCalled()
  })

  it('a release that throws still drops the session', () => {
    // Otherwise a flaky teardown is itself a permanent leak.
    const release = vi.fn(() => {
      throw new Error('detach failed')
    })
    const { reg, f, tick } = registry({ release })
    f.windows.set('ws', 1)
    reg.get('ws')

    f.windows.set('ws', 0)
    reg.drainTick()
    tick(DRAIN_DEBOUNCE_MS + 1)
    expect(() => reg.drainTick()).not.toThrow()
    expect(reg.resident()).toEqual([])
  })

  it('drains each dead session independently', () => {
    const release = vi.fn()
    const { reg, f, poll } = registry({ release })
    f.windows.set('a', 1)
    f.windows.set('b', 1)
    reg.get('a')
    reg.get('b')

    f.windows.set('a', 0)
    poll(DRAIN_DEBOUNCE_MS + 1)

    expect(release).toHaveBeenCalledWith('a', expect.anything())
    expect(release).not.toHaveBeenCalledWith('b', expect.anything())
    expect(reg.resident()).toEqual(['b'])
  })
})

describe('the invariant wave C failed', () => {
  it('a failed workspace creation leaves the registry at zero cost', () => {
    // Tonight-in-August, in one assertion: instantiate, fail, roll back —
    // and nothing is left marked live to tax every later sweep.
    const { reg, f, poll } = registry()
    f.windows.set('doomed', 1)
    reg.get('doomed')

    f.windows.delete('doomed') // rollback removed the window
    poll(DRAIN_DEBOUNCE_MS + 1)

    expect(reg.residentCount()).toBe(0)
    expect(reg.isLive('doomed')).toBe(false)
  })
})

describe('the drain cannot be pinned by its own poller (review M3)', () => {
  it('get() on every tick does NOT reset the death clock', () => {
    // The wiring in index.ts calls get() for every resident session each tick
    // so the registry can see what the store holds. If get() cleared deadSince
    // the drain could never fire and residency would grow forever — the
    // unbounded hold of ef5e13c, reached from the other direction.
    // Mirrors index.ts exactly: each tick materialises what the STORE still
    // holds, then lets liveness decide. Release removes it from the store, so
    // a released session is not re-got on the following tick.
    const held = new Set(['ws'])
    const release = vi.fn((id: string) => void held.delete(id))
    const { reg, f, tick } = registry({ release })
    f.windows.set('ws', 1)
    reg.get('ws')
    f.windows.set('ws', 0)

    for (let i = 0; i < 6; i += 1) {
      for (const id of held) reg.get(id) // the poller, as index.ts drives it
      reg.drainTick()
      tick(5_000)
    }

    expect(release).toHaveBeenCalledWith('ws', expect.anything())
    expect(reg.residentCount()).toBe(0)
    expect(held.size).toBe(0)
  })
})
