import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createShareDevicesStore, problemText, shareDevicesStoreFor, type ShareBridge } from '../src/renderer/src/routing/share-devices-store'
import { ShareDevicesBound } from '../src/renderer/src/routing/ShareDevices'
import type { SharedKey, ShareWhere } from '../src/shared/share-devices'

/**
 * SHARE WITH MY DEVICES, ACROSS THE PANEL CLOSING.
 *
 * The Routing panel unmounts when it closes, so everything an answer from the
 * main process has to land on lives in a store outside React. These drive that
 * store with answers held back and released in chosen orders.
 */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const key = (id: string, device = `dev-${id}`): SharedKey => ({ id: id.padEnd(24, '0'), name: `device-${device}`, device, limit: null })
const WHERE: ShareWhere = { onNetwork: true, urls: ['http://192.168.1.20:3425'] }

type ListAnswer = Awaited<ReturnType<NonNullable<ShareBridge['routeShareList']>>>
type IssueAnswer = Awaited<ReturnType<NonNullable<ShareBridge['routeShareIssue']>>>
type RevokeAnswer = Awaited<ReturnType<NonNullable<ShareBridge['routeShareRevoke']>>>

/** A bridge whose every answer waits until the test hands it out. */
function heldBridge() {
  const lists: Deferred<ListAnswer>[] = []
  const issues: Deferred<IssueAnswer>[] = []
  const revokes: Deferred<RevokeAnswer>[] = []
  const bridge = {
    routeShareList: vi.fn(() => {
      const d = deferred<ListAnswer>()
      lists.push(d)
      return d.promise
    }),
    routeShareIssue: vi.fn((_input: { device: string; dailyUsd: number }) => {
      const d = deferred<IssueAnswer>()
      issues.push(d)
      return d.promise
    }),
    routeShareRevoke: vi.fn((_id: string) => {
      const d = deferred<RevokeAnswer>()
      revokes.push(d)
      return d.promise
    })
  }
  return { bridge, lists, issues, revokes }
}

describe('share devices store: the panel closing mid-flight', () => {
  it('keeps an issued key that arrives while nobody is subscribed, and shows it on the next mount', async () => {
    const { bridge, issues, lists } = heldBridge()
    const store = createShareDevicesStore(bridge)
    const unsubscribe = store.subscribe(() => {})
    store.issue('laptop', 20)
    unsubscribe() // the panel closed

    issues[0].resolve({ ok: true, key: 'sk-magpie-onetimeonetime', shared: key('a', 'laptop') })
    await flush()

    const state = store.getSnapshot()
    expect(state.issued).toEqual({ id: key('a').id, key: 'sk-magpie-onetimeonetime', device: 'laptop' })
    expect(state.issuing).toBe(false)
    expect(state.keys.map((k) => k.id)).toEqual([key('a').id])
    expect(lists).toHaveLength(1) // re-read after the key was made

    const html = renderToStaticMarkup(createElement(ShareDevicesBound, { store, sharingEnabled: true }))
    expect(html).toContain('sk-magpie-onetimeonetime')
  })

  it('applies a revoke that finishes while the panel is closed', async () => {
    const { bridge, lists, revokes } = heldBridge()
    const store = createShareDevicesStore(bridge)
    store.read()
    lists[0].resolve({ ok: true, keys: [key('a'), key('b')], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()

    store.revoke(key('a').id)
    revokes[0].resolve({ ok: true })
    await flush()

    expect(store.getSnapshot().keys.map((k) => k.id)).toEqual([key('b').id])
    expect(store.getSnapshot().revoking).toEqual([])
  })

  it('hands out one store per bridge, so a remount finds the same state', () => {
    const { bridge } = heldBridge()
    expect(shareDevicesStoreFor(bridge)).toBe(shareDevicesStoreFor(bridge))
    expect(shareDevicesStoreFor(heldBridge().bridge)).not.toBe(shareDevicesStoreFor(bridge))
  })
})

describe('share devices store: revoke once', () => {
  it('sends one revoke per key while it is in flight, across remounts', async () => {
    const { bridge, revokes } = heldBridge()
    const store = shareDevicesStoreFor(bridge)
    const id = key('a').id
    store.revoke(id)
    store.revoke(id)
    expect(store.getSnapshot().revoking).toEqual([id])
    // A remount reaches the same store through shareDevicesStoreFor and clicks again.
    shareDevicesStoreFor(bridge).revoke(id)
    expect(bridge.routeShareRevoke).toHaveBeenCalledTimes(1)

    revokes[0].resolve({ ok: false, why: 'locked' })
    await flush()
    expect(store.getSnapshot().revoking).toEqual([])
    store.revoke(id) // a retry after the answer is a new revoke
    expect(bridge.routeShareRevoke).toHaveBeenCalledTimes(2)
  })
})

describe('share devices store: the one-time key', () => {
  it('survives reads that do not list it and reads that fail', async () => {
    const { bridge, issues, lists } = heldBridge()
    const store = createShareDevicesStore(bridge)
    store.issue('laptop', 20)
    issues[0].resolve({ ok: true, key: 'sk-magpie-keepme', shared: key('a', 'laptop') })
    await flush()

    lists[0].resolve({ ok: true, keys: [], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()
    expect(store.getSnapshot().issued?.key).toBe('sk-magpie-keepme')

    store.read()
    lists[1].reject(new Error('ipc gone'))
    await flush()
    expect(store.getSnapshot().issued?.key).toBe('sk-magpie-keepme')
  })

  it('refuses a second issue while one is in flight or a key is still shown', async () => {
    const { bridge, issues } = heldBridge()
    const store = createShareDevicesStore(bridge)
    store.issue('laptop', 20)
    store.issue('laptop', 20)
    expect(bridge.routeShareIssue).toHaveBeenCalledTimes(1)

    issues[0].resolve({ ok: true, key: 'sk-magpie-first', shared: key('a', 'laptop') })
    await flush()
    store.issue('phone', 5)
    expect(bridge.routeShareIssue).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().issued?.key).toBe('sk-magpie-first')

    store.done()
    expect(store.getSnapshot().issued).toBeNull()
    store.issue('phone', 5)
    expect(bridge.routeShareIssue).toHaveBeenCalledTimes(2)
  })

  it('drops the shown key when that key is revoked, and only that key', async () => {
    const { bridge, issues, revokes } = heldBridge()
    const store = createShareDevicesStore(bridge)
    store.issue('laptop', 20)
    issues[0].resolve({ ok: true, key: 'sk-magpie-dead', shared: key('a', 'laptop') })
    await flush()

    store.revoke(key('b').id)
    revokes[0].resolve({ ok: true })
    await flush()
    expect(store.getSnapshot().issued?.key).toBe('sk-magpie-dead')

    store.revoke(key('a').id)
    revokes[1].resolve({ ok: true })
    await flush()
    expect(store.getSnapshot().issued).toBeNull()
  })
})

describe('share devices store: reads out of order', () => {
  it('keeps the newer list when an older read answers last', async () => {
    const { bridge, lists } = heldBridge()
    const store = createShareDevicesStore(bridge)
    store.read()
    store.read()
    lists[1].resolve({ ok: true, keys: [key('a'), key('b')], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()
    lists[0].resolve({ ok: true, keys: [key('a')], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()
    expect(store.getSnapshot().keys.map((k) => k.id)).toEqual([key('a').id, key('b').id])
  })

  it('ignores an older read failing after a newer one succeeded', async () => {
    const { bridge, lists } = heldBridge()
    const store = createShareDevicesStore(bridge)
    store.read()
    store.read()
    lists[1].resolve({ ok: true, keys: [key('a')], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()
    lists[0].resolve({ ok: false, why: 'stale failure' })
    await flush()
    expect(problemText(store.getSnapshot())).toBeNull()
  })

  it('does not bring back a revoked key from a read that started before the revoke landed', async () => {
    const { bridge, lists, revokes } = heldBridge()
    const store = createShareDevicesStore(bridge)
    store.read()
    store.revoke(key('a').id)
    revokes[0].resolve({ ok: true })
    await flush()
    lists[0].resolve({ ok: true, keys: [key('a'), key('b')], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()
    expect(store.getSnapshot().keys.map((k) => k.id)).not.toContain(key('a').id)

    lists[1].resolve({ ok: true, keys: [key('b')], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()
    expect(store.getSnapshot().keys.map((k) => k.id)).toEqual([key('b').id])
  })
})

describe('share devices store: failures stay visible', () => {
  it('keeps the last good list when a read fails, and says so', async () => {
    const { bridge, lists } = heldBridge()
    const store = createShareDevicesStore(bridge)
    store.read()
    lists[0].resolve({ ok: true, keys: [key('a')], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()
    store.read()
    lists[1].resolve({ ok: false, why: 'Magpie is not running.' })
    await flush()
    expect(store.getSnapshot().keys.map((k) => k.id)).toEqual([key('a').id])
    expect(store.getSnapshot().where).toEqual(WHERE)
    expect(problemText(store.getSnapshot())).toBe('Magpie is not running.')

    store.read()
    lists[2].resolve({ ok: true, keys: [key('a')], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()
    expect(problemText(store.getSnapshot())).toBeNull()
  })

  it('treats a malformed list answer as a failure, not an empty list', async () => {
    const { bridge, lists } = heldBridge()
    const store = createShareDevicesStore(bridge)
    store.read()
    lists[0].resolve({ ok: true, keys: [key('a')], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()
    store.read()
    lists[1].resolve({ ok: true } as unknown as ListAnswer)
    await flush()
    expect(store.getSnapshot().keys.map((k) => k.id)).toEqual([key('a').id])
    expect(problemText(store.getSnapshot())).not.toBeNull()
  })

  it('keeps a failed revoke on screen through a later successful read', async () => {
    const { bridge, lists, revokes } = heldBridge()
    const store = createShareDevicesStore(bridge)
    store.read()
    lists[0].resolve({ ok: true, keys: [key('a')], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()
    store.revoke(key('a').id)
    revokes[0].resolve({ ok: false, why: 'Could not revoke.' })
    await flush()

    store.read()
    lists[1].resolve({ ok: true, keys: [key('a')], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()
    expect(problemText(store.getSnapshot())).toBe('Could not revoke.')

    store.read() // CHECK again: re-reading the list is not an answer to the revoke
    lists[2].resolve({ ok: true, keys: [key('a')], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()
    expect(problemText(store.getSnapshot())).toBe('Could not revoke.')
  })

  it('keeps a failed issue on screen alongside a read failure, and clears it on the next issue that works', async () => {
    const { bridge, issues, lists } = heldBridge()
    const store = createShareDevicesStore(bridge)
    store.issue('laptop', 20)
    issues[0].reject(new Error('ipc gone'))
    await flush()
    expect(store.getSnapshot().issuing).toBe(false)
    expect(store.getSnapshot().issued).toBeNull()

    store.read()
    lists[0].resolve({ ok: false, why: 'Magpie is not running.' })
    await flush()
    const text = problemText(store.getSnapshot()) ?? ''
    expect(text).toContain('Magpie is not running.')
    expect(text).toContain('Sharing needs Magpie')

    store.issue('laptop', 20)
    issues[1].resolve({ ok: true, key: 'sk-magpie-ok', shared: key('a', 'laptop') })
    await flush()
    expect(problemText(store.getSnapshot())).toBe('Magpie is not running.')
  })

  it('reports a bridge that throws instead of answering, and one without the channel', async () => {
    const thrower: ShareBridge = {
      routeShareList: () => {
        throw new Error('sync throw')
      },
      routeShareRevoke: () => {
        throw new Error('sync throw')
      }
    }
    const store = createShareDevicesStore(thrower)
    store.read()
    store.revoke(key('a').id)
    await flush()
    expect(problemText(store.getSnapshot())).not.toBeNull()
    expect(store.getSnapshot().revoking).toEqual([])

    store.issue('laptop', 20) // no routeShareIssue on this bridge
    expect(store.getSnapshot().issuing).toBe(false)
    expect(store.getSnapshot().problems.some((p) => p.from === 'issue')).toBe(true)
  })

  it('tells subscribers about each change, with a fresh snapshot each time', async () => {
    const { bridge, lists } = heldBridge()
    const store = createShareDevicesStore(bridge)
    const seen = vi.fn()
    store.subscribe(seen)
    const before = store.getSnapshot()
    store.read()
    lists[0].resolve({ ok: true, keys: [key('a')], where: WHERE, pending: [], issuing: false, handover: null })
    await flush()
    expect(seen).toHaveBeenCalled()
    expect(store.getSnapshot()).not.toBe(before)
    expect(before.keys).toEqual([])
  })
})
