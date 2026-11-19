// YOUR COMPUTERS, OUTSIDE REACT (routing/magpie-remote-store.ts): a connect that
// answers after the panel closed lands on the store and shows on the next mount;
// a failure stays until that computer's next try works; one try per computer.
import { describe, expect, it, vi } from 'vitest'
import { createMagpieRemoteStore, type MagpieRemoteBridge } from '../src/renderer/src/routing/magpie-remote-store'
import type { MagpieRemoteList } from '../src/shared/remote-magpie'

const PEER = 'deviceB0000000000000000000000002'
const list = (providerId: string | null = null): MagpieRemoteList => ({
  signedIn: true,
  forwarder: 3428,
  sealed: true,
  problem: null,
  desktopsKnown: true,
  desktops: [{ id: PEER, name: 'Solis-Core', online: true, providerId, os: 'linux', arch: 'x64' }]
})

function held<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('magpie remote store', () => {
  it('keeps a connect that answers while the panel is closed, and shows it on the next mount', async () => {
    let answer = list()
    const pending = held<{ ok: true; providerId: string }>()
    const bridge: MagpieRemoteBridge = { magpieRemoteList: vi.fn(async () => answer), magpieRemoteConnect: vi.fn(() => pending.promise) }
    const store = createMagpieRemoteStore(bridge)
    await store.read()
    const off = store.subscribe(() => {})
    const going = store.connect(PEER, 'Solis-Core')
    expect(store.getSnapshot().busy).toEqual([PEER])
    off()
    answer = list('solis-core')
    pending.resolve({ ok: true, providerId: 'solis-core' })
    await going
    await new Promise((r) => setTimeout(r, 0))
    expect(store.getSnapshot()).toMatchObject({ busy: [], problems: {} })
    expect(store.getSnapshot().list?.desktops[0].providerId).toBe('solis-core')
  })

  it('sends one connect per computer while one is in flight', async () => {
    const pending = held<{ ok: true; providerId: string }>()
    const connect = vi.fn(() => pending.promise)
    const store = createMagpieRemoteStore({ magpieRemoteList: async () => list(), magpieRemoteConnect: connect })
    void store.connect(PEER, 'Solis-Core')
    void store.connect(PEER, 'Solis-Core')
    expect(connect).toHaveBeenCalledTimes(1)
    pending.resolve({ ok: true, providerId: 'solis-core' })
  })

  it('keeps a failure on screen through reads, and clears it when the next try works', async () => {
    const connect = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, why: 'Magpie remote is switched off on Solis-Core.' })
      .mockResolvedValueOnce({ ok: true, providerId: 'solis-core' })
    const store = createMagpieRemoteStore({ magpieRemoteList: async () => list(), magpieRemoteConnect: connect })
    await store.connect(PEER, 'Solis-Core')
    expect(store.getSnapshot().problems[PEER]).toContain('switched off')
    await store.read()
    expect(store.getSnapshot().problems[PEER]).toContain('switched off')
    await store.connect(PEER, 'Solis-Core')
    expect(store.getSnapshot().problems[PEER]).toBeUndefined()
  })

  it('treats a bridge that throws, or has no channel, as a failure that says so', async () => {
    const store = createMagpieRemoteStore({ magpieRemoteList: async () => list(), magpieRemoteConnect: () => { throw new Error('ipc gone') } })
    await store.connect(PEER, 'Solis-Core')
    expect(store.getSnapshot().problems[PEER]).toBeTruthy()
    const none = createMagpieRemoteStore({})
    await none.read()
    expect(none.getSnapshot().readProblem).toBeTruthy()
  })

  it('keeps the newer list when an older read answers last', async () => {
    const first = held<MagpieRemoteList>()
    const second = held<MagpieRemoteList>()
    const reads = [first, second]
    const store = createMagpieRemoteStore({ magpieRemoteList: () => (reads.shift() as ReturnType<typeof held<MagpieRemoteList>>).promise })
    const a = store.read()
    const b = store.read()
    second.resolve(list('solis-core'))
    await b
    first.resolve(list(null))
    await a
    expect(store.getSnapshot().list?.desktops[0].providerId).toBe('solis-core')
  })

  it('disconnects, and reads again', async () => {
    let answer = list('solis-core')
    const disconnect = vi.fn(async () => {
      answer = list(null)
      return { ok: true as const }
    })
    const store = createMagpieRemoteStore({ magpieRemoteList: async () => answer, magpieRemoteDisconnect: disconnect })
    await store.read()
    await store.disconnect(PEER)
    await new Promise((r) => setTimeout(r, 0))
    expect(disconnect).toHaveBeenCalledWith(PEER)
    expect(store.getSnapshot().list?.desktops[0].providerId).toBeNull()
  })
})
