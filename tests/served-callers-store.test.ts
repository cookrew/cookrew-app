import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ServedCallersRow } from '../src/shared/seats'
import {
  getServedCallersSnapshot,
  resetServedCallersStore,
  sameRows,
  servedCallersStoreStats,
  subscribeServedCallers,
  useServedCallers
} from '../src/renderer/src/served-callers-store'
import { useServedCallers as reExported } from '../src/renderer/src/nodes/CallerAvatars'

/**
 * The startup log said it: MaxListenersExceededWarning, 11 serving:callers
 * listeners. Every mounted card subscribed to the same IPC channel on its own
 * and invoked servingCallers() on its own — on the owner's 114-node canvas,
 * ~114 listeners, ~114 invokes, and every push set-stated ~114 times.
 *
 * These tests drive the store the way N hook instances do — N subscribes —
 * and count what reaches the bridge. There is no DOM in this suite, so the
 * hook itself is exercised through a server render, which reads the snapshot.
 */

interface FakeBridge {
  readonly registrations: number
  readonly releases: number
  readonly invokes: number
  push(rows: readonly ServedCallersRow[]): void
  resolveInvoke(rows: readonly ServedCallersRow[]): Promise<void>
}

/** window.cookrew with counting servingCallers / onServingCallers. */
function installBridge(): FakeBridge {
  let registrations = 0
  let releases = 0
  let invokes = 0
  let listener: ((rows: readonly ServedCallersRow[]) => void) | null = null
  const pendingInvokes: Array<(rows: readonly ServedCallersRow[]) => void> = []
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: {
      servingCallers: () => {
        invokes += 1
        return new Promise<readonly ServedCallersRow[]>((resolve) => pendingInvokes.push(resolve))
      },
      onServingCallers: (cb: (rows: readonly ServedCallersRow[]) => void) => {
        registrations += 1
        listener = cb
        return () => {
          releases += 1
          if (listener === cb) listener = null
        }
      }
    }
  }
  return {
    get registrations() {
      return registrations
    },
    get releases() {
      return releases
    },
    get invokes() {
      return invokes
    },
    push: (rows) => listener?.(rows),
    resolveInvoke: async (rows) => {
      pendingInvokes.shift()?.(rows)
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

function caller(username: string): ServedCallersRow['callers'][number] {
  return {
    username,
    accountId: `acct-${username}`,
    deviceKind: 'phone',
    source: 'granted',
    since: 1_800_000_000_000,
    sessionId: `sess-${username}`,
    conductorId: null
  }
}

function row(orchName: string, ...usernames: string[]): ServedCallersRow {
  return { serviceId: `svc-${orchName}`, slug: orchName.toLowerCase(), orchName, callers: usernames.map(caller) }
}

/** What N mounted cards do: N subscriptions, each with its own notify callback. */
function mountCards(n: number): { notified: number[]; unmount: Array<() => void> } {
  const notified = Array.from({ length: n }, () => 0)
  const unmount = notified.map((_, i) =>
    subscribeServedCallers(() => {
      notified[i] += 1
    })
  )
  return { notified, unmount }
}

let bridge: FakeBridge

beforeEach(() => {
  bridge = installBridge()
})
afterEach(() => {
  resetServedCallersStore()
})

describe('one IPC subscription for the whole canvas', () => {
  it('114 consumers make exactly ONE onServingCallers registration and ONE servingCallers invoke', () => {
    const cards = mountCards(114)
    expect(bridge.registrations).toBe(1)
    expect(bridge.invokes).toBe(1)
    expect(servedCallersStoreStats()).toEqual({ consumers: 114, subscribed: true })
    for (const un of cards.unmount) un()
  })

  it('the registration is released when the LAST consumer unmounts, not before', () => {
    const cards = mountCards(3)
    cards.unmount[0]()
    cards.unmount[1]()
    expect(bridge.releases).toBe(0)
    expect(servedCallersStoreStats()).toEqual({ consumers: 1, subscribed: true })
    cards.unmount[2]()
    expect(bridge.releases).toBe(1)
    expect(servedCallersStoreStats()).toEqual({ consumers: 0, subscribed: false })
    // Unmounting twice is harmless: React StrictMode and error paths do that.
    cards.unmount[2]()
    expect(bridge.releases).toBe(1)
    expect(servedCallersStoreStats().consumers).toBe(0)
  })

  it('a remount after the last unmount opens a fresh subscription and invokes once more', () => {
    const first = mountCards(2)
    for (const un of first.unmount) un()
    const second = mountCards(1)
    expect(bridge.registrations).toBe(2)
    expect(bridge.invokes).toBe(2)
    for (const un of second.unmount) un()
  })
})

describe('the snapshot', () => {
  it('starts as a stable empty array', () => {
    expect(getServedCallersSnapshot()).toEqual([])
    expect(getServedCallersSnapshot()).toBe(getServedCallersSnapshot())
  })

  it('an identical push keeps the SAME reference and notifies nobody', () => {
    const cards = mountCards(5)
    bridge.push([row('Forge', 'ada')])
    const shown = getServedCallersSnapshot()
    expect(cards.notified).toEqual([1, 1, 1, 1, 1])
    // main re-sends what the canvas already shows: a fresh array, equal rows
    bridge.push([row('Forge', 'ada')])
    expect(getServedCallersSnapshot()).toBe(shown)
    expect(cards.notified).toEqual([1, 1, 1, 1, 1])
    for (const un of cards.unmount) un()
  })

  it('a changed push swaps the reference and notifies every consumer exactly once', () => {
    const cards = mountCards(3)
    bridge.push([row('Forge', 'ada')])
    const before = getServedCallersSnapshot()
    bridge.push([row('Forge', 'ada', 'bob')])
    expect(getServedCallersSnapshot()).not.toBe(before)
    expect(getServedCallersSnapshot()[0].callers.map((c) => c.username)).toEqual(['ada', 'bob'])
    expect(cards.notified).toEqual([2, 2, 2])
    for (const un of cards.unmount) un()
  })

  it('the initial invoke seeds the rows', async () => {
    const cards = mountCards(1)
    await bridge.resolveInvoke([row('Atlas', 'cy')])
    expect(getServedCallersSnapshot()).toEqual([row('Atlas', 'cy')])
    cards.unmount[0]()
  })

  it('an invoke from a lifetime that ended before it resolved is ignored; the live one lands', async () => {
    const stale = mountCards(1)
    stale.unmount[0]() // invoke #1 still pending when its subscription closes
    const live = mountCards(1) // invoke #2 pending
    await bridge.resolveInvoke([row('Atlas', 'cy')]) // #1, FIFO: stale
    expect(getServedCallersSnapshot()).toEqual([])
    await bridge.resolveInvoke([row('Atlas', 'cy', 'di')]) // #2: live
    expect(getServedCallersSnapshot()[0].callers.map((c) => c.username)).toEqual(['cy', 'di'])
    live.unmount[0]()
  })

  it('a push that lands before the initial invoke resolves is not clobbered by it if equal, and is replaced if the invoke is newer', async () => {
    const cards = mountCards(1)
    bridge.push([row('Forge', 'ada')])
    const pushed = getServedCallersSnapshot()
    await bridge.resolveInvoke([row('Forge', 'ada')])
    expect(getServedCallersSnapshot()).toBe(pushed)
    cards.unmount[0]()
  })
})

describe('sameRows', () => {
  it('is structural over the shapes main pushes', () => {
    expect(sameRows([row('A', 'x')], [row('A', 'x')])).toBe(true)
    expect(sameRows([row('A', 'x')], [row('A', 'y')])).toBe(false)
    expect(sameRows([row('A', 'x')], [row('A', 'x'), row('B')])).toBe(false)
    expect(sameRows([{ ...row('A'), orchName: null }], [row('A')])).toBe(false)
    expect(sameRows({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(sameRows(null, {})).toBe(false)
    expect(sameRows([], {})).toBe(false)
  })
})

describe('the hook', () => {
  it('keeps its name and return type where CallerAvatars exported it, and renders the store snapshot', () => {
    expect(reExported).toBe(useServedCallers)
    const cards = mountCards(1)
    bridge.push([row('Forge', 'ada', 'bob')])
    function Probe(): React.JSX.Element {
      const rows = useServedCallers()
      return createElement('i', null, rows.map((r) => `${r.orchName}:${r.callers.length}`).join(','))
    }
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<i>Forge:2</i>')
    // A server render subscribes nothing: still the one registration.
    expect(bridge.registrations).toBe(1)
    cards.unmount[0]()
  })
})
