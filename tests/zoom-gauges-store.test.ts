// THE RENDERER'S WATCH: it asks only while somebody is drawn at the devices
// stop, one question at a time, and it tells the one leaf that draws that
// machine and nobody else. On the relay a question is an exchange out of a
// budget of sixteen (cookrew-relay-transport), so a late answer must delay the
// next question, never queue behind it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createGaugeStore,
  GAUGE_BACKOFF_MAX_MS,
  GAUGE_POLL_MS,
  GAUGE_REMOTE_POLL_MS,
  GAUGE_STALE_MS,
  atDevicesStop,
  type GaugeSight
} from '../src/renderer/src/zoom/gauge-store'
import { fetchGauges, GAUGE_FETCH_TIMEOUT_MS, relayDesktopGauges } from '../src/renderer/src/relay-gauges'
import type { MachineGauges } from '../src/shared/machine-gauges'

const reading = (at: number): MachineGauges => ({ at, cpuPercent: 10, memory: null, disk: null, gpuPercent: null })
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}
const sightOf = (hidden = false): GaugeSight & { hidden: () => boolean; set: (h: boolean) => void } => {
  let now = hidden
  const watchers = new Set<() => void>()
  return {
    hidden: () => now,
    watch: (changed) => {
      watchers.add(changed)
      return () => void watchers.delete(changed)
    },
    set: (h) => {
      now = h
      watchers.forEach((w) => w())
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('asking', () => {
  it('asks nothing before a leaf watches', async () => {
    const ask = vi.fn(async () => reading(1))
    createGaugeStore({ ask })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ask).not.toHaveBeenCalled()
  })
  it('asks at once, then every few seconds', async () => {
    const ask = vi.fn(async () => reading(1))
    const store = createGaugeStore({ ask })
    store.watch('local', true)
    await flush()
    expect(ask).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(GAUGE_POLL_MS * 3)
    expect(ask).toHaveBeenCalledTimes(4)
  })
  it('stops when the last leaf lets go', async () => {
    const ask = vi.fn(async () => reading(1))
    const store = createGaugeStore({ ask })
    const release = store.watch('local', true)
    await flush()
    release()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('two leaves of one machine share one loop', async () => {
    const ask = vi.fn(async () => reading(1))
    const store = createGaugeStore({ ask })
    const one = store.watch('local', true)
    const two = store.watch('local', true)
    await flush()
    expect(ask).toHaveBeenCalledTimes(1)
    one()
    await vi.advanceTimersByTimeAsync(GAUGE_POLL_MS)
    expect(ask).toHaveBeenCalledTimes(2)
    two()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ask).toHaveBeenCalledTimes(2)
  })
  it('never has two questions out: a stalled Mac delays the next, it does not stack them', async () => {
    let answer = (_: MachineGauges): void => undefined
    const ask = vi.fn(() => new Promise<MachineGauges>((resolve) => { answer = resolve }))
    const store = createGaugeStore({ ask })
    store.watch('local', true)
    await vi.advanceTimersByTimeAsync(GAUGE_POLL_MS * 20)
    expect(ask).toHaveBeenCalledTimes(1)
    answer(reading(1))
    await vi.advanceTimersByTimeAsync(GAUGE_POLL_MS)
    expect(ask).toHaveBeenCalledTimes(2)
  })
  it('leaving the stop and coming back with a question out does not send a second: each one is a relay slot', async () => {
    let answer = (_: MachineGauges): void => undefined
    const ask = vi.fn(() => new Promise<MachineGauges>((resolve) => { answer = resolve }))
    const store = createGaugeStore({ ask })
    for (let i = 0; i < 5; i++) store.watch('local', true)()
    store.watch('local', true)
    await flush()
    expect(ask).toHaveBeenCalledTimes(1)
    answer(reading(1))
    await flush()
    expect(store.get('local')).toMatchObject({ cpuPercent: 10 })
    await vi.advanceTimersByTimeAsync(GAUGE_POLL_MS)
    expect(ask).toHaveBeenCalledTimes(2)
  })
  it('a machine that keeps saying nothing is asked less and less: a wall TV’s 401 is not news every 4 s', async () => {
    const ask = vi.fn(async () => null)
    const store = createGaugeStore({ ask })
    store.watch('local', true)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(ask.mock.calls.length).toBeLessThan((10 * 60_000) / GAUGE_BACKOFF_MAX_MS + 8)
  })
  it('an answer ends the backing off', async () => {
    let up = false
    const ask = vi.fn(async () => (up ? reading(1) : null))
    const store = createGaugeStore({ ask })
    store.watch('local', true)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    up = true
    await vi.advanceTimersByTimeAsync(GAUGE_BACKOFF_MAX_MS)
    const before = ask.mock.calls.length
    await vi.advanceTimersByTimeAsync(GAUGE_POLL_MS * 3)
    expect(ask.mock.calls.length - before).toBe(3)
  })
  it('asks another desktop on a slower clock', async () => {
    const ask = vi.fn(async () => reading(1))
    const store = createGaugeStore({ ask })
    store.watch('other', false)
    await flush()
    await vi.advanceTimersByTimeAsync(GAUGE_POLL_MS)
    expect(ask).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(GAUGE_REMOTE_POLL_MS - GAUGE_POLL_MS)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(ask).toHaveBeenCalledWith('other', false)
  })
  it('an answer that lands after the leaf let go is dropped', async () => {
    let answer = (_: MachineGauges): void => undefined
    const ask = vi.fn(() => new Promise<MachineGauges>((resolve) => { answer = resolve }))
    const store = createGaugeStore({ ask })
    const heard = vi.fn()
    store.subscribe('local', heard)
    store.watch('local', true)()
    answer(reading(1))
    await flush()
    expect(store.get('local')).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('out of sight', () => {
  it('a hidden window asks nothing, and a returning one asks at once', async () => {
    const sight = sightOf(true)
    const ask = vi.fn(async () => reading(1))
    const store = createGaugeStore({ ask, sight })
    store.watch('local', true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ask).not.toHaveBeenCalled()
    sight.set(false)
    await flush()
    expect(ask).toHaveBeenCalledTimes(1)
  })
  it('going hidden stops the clock', async () => {
    const sight = sightOf()
    const ask = vi.fn(async () => reading(1))
    const store = createGaugeStore({ ask, sight })
    store.watch('local', true)
    await flush()
    sight.set(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('hidden and back with a question still out: still one question, and its answer counts', async () => {
    const sight = sightOf()
    let answer = (_: MachineGauges): void => undefined
    const ask = vi.fn(() => new Promise<MachineGauges>((resolve) => { answer = resolve }))
    const store = createGaugeStore({ ask, sight })
    store.watch('local', true)
    await flush()
    sight.set(true)
    sight.set(false)
    await flush()
    expect(ask).toHaveBeenCalledTimes(1)
    answer(reading(1))
    await flush()
    expect(store.get('local')).toMatchObject({ cpuPercent: 10 })
    await vi.advanceTimersByTimeAsync(GAUGE_POLL_MS)
    expect(ask).toHaveBeenCalledTimes(2)
  })
  it('stops watching the window with its last leaf', async () => {
    const sight = sightOf()
    const unwatch = vi.fn()
    const store = createGaugeStore({ ask: async () => reading(1), sight: { ...sight, watch: () => unwatch } })
    store.watch('local', true)()
    expect(unwatch).toHaveBeenCalledTimes(1)
  })
})

describe('what a leaf hears', () => {
  it('only its own machine', async () => {
    const store = createGaugeStore({ ask: async () => reading(1) })
    const mine = vi.fn()
    const theirs = vi.fn()
    store.subscribe('a', mine)
    store.subscribe('b', theirs)
    store.watch('a', true)
    await flush()
    expect(mine).toHaveBeenCalledTimes(1)
    expect(theirs).not.toHaveBeenCalled()
  })
  it('undefined before the first answer, the reading after, the same object until the next', async () => {
    const store = createGaugeStore({ ask: async () => reading(1) })
    expect(store.get('a')).toBeUndefined()
    store.watch('a', true)
    await flush()
    const first = store.get('a')
    expect(first).toMatchObject({ cpuPercent: 10 })
    expect(store.get('a')).toBe(first)
  })
  it('a machine that never answered is no reading at once', async () => {
    const store = createGaugeStore({ ask: async () => null })
    store.watch('a', false)
    await flush()
    expect(store.get('a')).toBeNull()
  })
  it('a failed question reads as no answer, it does not end the loop', async () => {
    const ask = vi.fn<() => Promise<MachineGauges | null>>().mockRejectedValueOnce(new Error('gone')).mockResolvedValue(reading(1))
    const store = createGaugeStore({ ask })
    store.watch('a', true)
    await flush()
    expect(store.get('a')).toBeNull()
    await vi.advanceTimersByTimeAsync(GAUGE_POLL_MS)
    expect(store.get('a')).toMatchObject({ cpuPercent: 10 })
  })
  it('one dropped answer keeps the last numbers; a machine gone quiet stops claiming them', async () => {
    let up = true
    const store = createGaugeStore({ ask: async () => (up ? reading(1) : null) })
    store.watch('a', true)
    await flush()
    up = false
    await vi.advanceTimersByTimeAsync(GAUGE_POLL_MS)
    expect(store.get('a')).toMatchObject({ cpuPercent: 10 })
    await vi.advanceTimersByTimeAsync(GAUGE_STALE_MS)
    expect(store.get('a')).toBeNull()
  })
  it('stops claiming the numbers on its own clock, with a question still out: a stalled Mac must not look calm', async () => {
    let calls = 0
    const ask = vi.fn(() => (calls++ === 0 ? Promise.resolve(reading(1)) : new Promise<MachineGauges>(() => undefined)))
    const store = createGaugeStore({ ask })
    const heard = vi.fn()
    store.subscribe('a', heard)
    store.watch('a', true)
    await flush()
    expect(store.get('a')).toMatchObject({ cpuPercent: 10 })
    await vi.advanceTimersByTimeAsync(GAUGE_STALE_MS - 1)
    expect(store.get('a')).toMatchObject({ cpuPercent: 10 })
    await vi.advanceTimersByTimeAsync(1)
    expect(store.get('a')).toBeNull()
    expect(heard).toHaveBeenCalledTimes(2)
  })
  it('a fresh answer moves that clock', async () => {
    const store = createGaugeStore({ ask: async () => reading(1) })
    store.watch('a', true)
    await vi.advanceTimersByTimeAsync(GAUGE_STALE_MS * 3)
    expect(store.get('a')).toMatchObject({ cpuPercent: 10 })
  })
  it('a window that went away comes back to nothing old: hours-old numbers must not greet a woken phone', async () => {
    const sight = sightOf()
    const store = createGaugeStore({ ask: async () => reading(1), sight })
    store.watch('a', true)
    await flush()
    sight.set(true)
    expect(store.get('a')).toBeUndefined()
  })
  it('forgets the reading when it stops watching: the next visit shows nothing old', async () => {
    const store = createGaugeStore({ ask: async () => reading(1) })
    const release = store.watch('a', true)
    await flush()
    release()
    expect(store.get('a')).toBeUndefined()
  })
})

describe('on screen means the devices stop', () => {
  const at = (v: number, dir: 'agents' | 'items' = 'agents', full: 'agent' | 'item' | null = null) => ({ dir, v, full })
  it('at the stop, on either side', () => {
    expect(atDevicesStop(at(-2))).toBe(true)
    expect(atDevicesStop(at(-2, 'items'))).toBe(true)
  })
  it('anywhere else, no', () => {
    for (const v of [-1, 0, 1, 2, 3]) expect(atDevicesStop(at(v))).toBe(false)
  })
  it('never under a full view', () => {
    expect(atDevicesStop(at(-2, 'agents', 'agent'))).toBe(false)
  })
})

describe('the phone asking its Mac', () => {
  const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status })
  const GOOD = reading(5)
  it('reads a reading', async () => {
    expect(await fetchGauges('/api/fleet/gauges', 'tok', async () => answer(200, GOOD))).toEqual(GOOD)
  })
  it('sends its token as a header, never in the URL', async () => {
    const fetcher = vi.fn(async () => answer(200, GOOD))
    await fetchGauges('/api/fleet/gauges', 'tok', fetcher)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).not.toContain('tok')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })
  it('a refusal is no reading and nothing more: a TV must not be sent to the re-pair screen by a gauge', async () => {
    expect(await fetchGauges('/api/fleet/gauges', 'wall', async () => answer(401, { error: 'no' }))).toBeNull()
  })
  it('a Mac too old for the route, a dead link, a page that is not JSON: no reading', async () => {
    expect(await fetchGauges('/x', 'tok', async () => answer(404, {}))).toBeNull()
    expect(await fetchGauges('/x', 'tok', async () => { throw new Error('offline') })).toBeNull()
    expect(await fetchGauges('/x', 'tok', async () => new Response('<html>', { status: 200 }))).toBeNull()
  })
  it('gives up on a hung exchange: it holds one of the relay’s slots', async () => {
    let signal: AbortSignal | undefined
    const hung = (_: string, init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        signal = init.signal ?? undefined
        signal?.addEventListener('abort', () => reject(signal?.reason))
      })
    const pending = fetchGauges('/x', 'tok', hung)
    await vi.advanceTimersByTimeAsync(GAUGE_FETCH_TIMEOUT_MS)
    expect(await pending).toBeNull()
    expect(signal?.aborted).toBe(true)
  })
  it('giving up is the caller’s choice, not the link’s failure: a swapping Mac must not flip the data plane', async () => {
    let signal: AbortSignal | undefined
    const pending = fetchGauges('/x', 'tok', (_, init) => {
      signal = init.signal ?? undefined
      return new Promise(() => undefined)
    })
    await vi.advanceTimersByTimeAsync(GAUGE_FETCH_TIMEOUT_MS)
    // plane-fetch.ts · transportFailed: anything but AbortError feeds planeHealth.
    expect((signal?.reason as Error).name).toBe('AbortError')
    void pending
  })
  it('leaves no timer behind an answer', async () => {
    await fetchGauges('/x', 'tok', async () => answer(200, GOOD))
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the phone asking another desktop, through the relay', () => {
  const ME = '0f8f1c2e-1111-4222-8333-944445555666'
  const OTHER = '1a2b3c4d-aaaa-4bbb-8ccc-ddddeeeeffff'
  const BASE = `/relay/@drej/desktop/${ME}`
  const GOOD = reading(5)
  const okFetch = (): ReturnType<typeof vi.fn> => vi.fn(async () => new Response(JSON.stringify(GOOD), { status: 200 }))

  it('asks that Mac’s own path with that Mac’s own token', async () => {
    const fetcher = okFetch()
    const tokens = vi.fn((key: string) => (key === `cr_token:${OTHER}` ? 'other-mac-token' : null))
    expect(await relayDesktopGauges(BASE, OTHER, tokens, fetcher as never)).toEqual(GOOD)
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/relay/@drej/desktop/${OTHER}/api/fleet/gauges`)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer other-mac-token')
  })
  it('never sends this Mac’s token to another Mac', async () => {
    const fetcher = okFetch()
    expect(await relayDesktopGauges(BASE, OTHER, (key) => (key === `cr_token:${ME}` ? 'mine' : null), fetcher as never)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('holding no token for it, asks nobody and says no reading', async () => {
    const fetcher = okFetch()
    expect(await relayDesktopGauges(BASE, OTHER, () => null, fetcher as never)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('a page the Mac serves itself has no relay to ask through', async () => {
    const fetcher = okFetch()
    expect(await relayDesktopGauges('', OTHER, () => 'tok', fetcher as never)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('an id that is not an id never reaches a path', async () => {
    const fetcher = okFetch()
    expect(await relayDesktopGauges(BASE, '../../v2/me', () => 'tok', fetcher as never)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('a desktop off its line is no reading', async () => {
    expect(await relayDesktopGauges(BASE, OTHER, () => 'tok', (async () => new Response('{}', { status: 503 })) as never)).toBeNull()
  })
})
