import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBoardHolds, navigationEndsHold, type HoldSender } from '../src/main/board-hold'
import type { BoardSources } from '../src/main/board-index'

/**
 * The desktop panel's hold on the probe (src/main/board-hold.ts): refcounted
 * per sender, pushed on change, and released on the last unsubscribe, the
 * page going (a main-frame navigation — not an iframe card's, not
 * history.replaceState), a renderer crash, or the webContents' end.
 */
function sender(id: number) {
  const events = new EventEmitter()
  const sent: string[] = []
  let destroyed = false
  const s = {
    id,
    isDestroyed: () => destroyed,
    send: (channel: string) => void sent.push(channel),
    on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
    removeListener: (event: string, listener: (...args: unknown[]) => void) => events.removeListener(event, listener)
  } as HoldSender
  return {
    sender: s,
    sent,
    emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
    listeners: () => events.eventNames().reduce((n, e) => n + events.listenerCount(e), 0),
    destroy: () => {
      destroyed = true
      events.emit('destroyed')
    }
  }
}

function fixture() {
  let probeHolds = 0
  const changeListeners = new Set<() => void>()
  const sources: BoardSources = {
    activeWorkspaceId: () => 'ws',
    live: () => [],
    ledger: () => new Map(),
    registry: () => [],
    probe: () => new Map(),
    probeSubscribe: () => {
      probeHolds += 1
      return () => void (probeHolds -= 1)
    },
    probeOnChange: (listener) => {
      changeListeners.add(listener)
      return () => void changeListeners.delete(listener)
    }
  }
  const turns = new EventEmitter()
  const store = new EventEmitter()
  const holds = createBoardHolds({ sources: () => sources, turns, store })
  return { holds, probeHolds: () => probeHolds, fireChange: () => changeListeners.forEach((l) => l()), turns, store }
}

describe('navigationEndsHold', () => {
  it('ends the hold only for a main-frame navigation that replaces the document', () => {
    expect(navigationEndsHold({ isMainFrame: true, isSameDocument: false })).toBe(true)
    expect(navigationEndsHold({ isMainFrame: false, isSameDocument: false })).toBe(false) // a legacy iframe card
    expect(navigationEndsHold({ isMainFrame: true, isSameDocument: true })).toBe(false) // history.replaceState
    expect(navigationEndsHold(undefined)).toBe(true) // the positional form: safe side
  })
})

describe('board holds', () => {
  afterEach(() => vi.useRealTimers())

  it('refcounts per sender: two subscribes share one probe hold, two unsubscribes release it', () => {
    const f = fixture()
    const a = sender(1)
    expect(f.holds.subscribe(a.sender)).toBe(true)
    expect(f.holds.subscribe(a.sender)).toBe(true)
    expect(f.probeHolds()).toBe(1)
    expect(f.holds.count()).toBe(1)
    expect(f.holds.unsubscribe(a.sender)).toBe(true)
    expect(f.probeHolds()).toBe(1)
    expect(f.holds.unsubscribe(a.sender)).toBe(true)
    expect(f.probeHolds()).toBe(0)
    expect(f.holds.count()).toBe(0)
    expect(f.holds.unsubscribe(a.sender)).toBe(false)
    expect(a.listeners()).toBe(0) // every listener removed inside release
  })

  it('pushes the board on a probe change, coalesced', () => {
    vi.useFakeTimers()
    const f = fixture()
    const a = sender(2)
    f.holds.subscribe(a.sender)
    f.fireChange()
    f.fireChange()
    f.turns.emit('activity')
    expect(a.sent).toEqual([])
    vi.advanceTimersByTime(600)
    expect(a.sent).toEqual(['board:update'])
    f.holds.unsubscribe(a.sender)
    f.store.emit('change')
    vi.advanceTimersByTime(600)
    expect(a.sent).toEqual(['board:update']) // released: nothing more arrives
  })

  it('a reload (main-frame navigation) releases; an iframe navigation or replaceState does not', () => {
    const f = fixture()
    const a = sender(3)
    f.holds.subscribe(a.sender)
    a.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    a.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(f.probeHolds()).toBe(1)
    a.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(f.probeHolds()).toBe(0)
    expect(f.holds.count()).toBe(0)
    expect(a.listeners()).toBe(0)
  })

  it('a renderer crash or the webContents going releases, and a reload cycle leaks nothing', () => {
    const f = fixture()
    const a = sender(4)
    f.holds.subscribe(a.sender)
    a.emit('render-process-gone')
    expect(f.probeHolds()).toBe(0)
    for (let i = 0; i < 20; i += 1) {
      f.holds.subscribe(a.sender)
      a.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    }
    expect(f.probeHolds()).toBe(0)
    expect(a.listeners()).toBe(0) // twenty reloads, no listener left behind
    f.holds.subscribe(a.sender)
    a.destroy()
    expect(f.probeHolds()).toBe(0)
  })

  it('a stale release from an earlier cycle cannot delete a newer hold', () => {
    const f = fixture()
    const a = sender(5)
    f.holds.subscribe(a.sender)
    // Capture the first cycle's navigation listener, then end that cycle.
    const events = a as unknown as { emit: (e: string, ...args: unknown[]) => void }
    f.holds.unsubscribe(a.sender)
    f.holds.subscribe(a.sender) // the newer hold
    events.emit('did-start-navigation', { isMainFrame: false }) // nothing for the new one either
    expect(f.probeHolds()).toBe(1)
    f.holds.unsubscribe(a.sender)
    expect(f.probeHolds()).toBe(0)
  })
})
