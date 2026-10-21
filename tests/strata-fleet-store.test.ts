import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetMachine, LevelsEvent, LevelsSnapshot, StrataMachine } from '../src/shared/strata'
import { syntheticFleet } from '../src/strata/fixture/synthetic'
import { backoffDelay, OUTDATED_RECHECK_MS } from '../src/strata/fleet/backoff'
import { createFleetCache, type StorageLike } from '../src/strata/fleet/fleet-cache'
import { onlinePicture } from '../src/strata/fleet/fleet-online'
import { createFleetStore, FLEET_TIMINGS, type FleetConfig, type FleetDeps, type StreamHandlers } from '../src/strata/fleet/fleet-store'

const NOW = 1_800_000_000_000
const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWX'
const fixture = syntheticFleet(NOW)
const studio = fixture.find((m) => m.id === 'syn-studio')!
const SNAP = studio.levels as LevelsSnapshot

const row = (id: string, patch: Partial<FleetMachine> = {}): FleetMachine => ({
  id,
  name: id,
  online: true,
  lastSeenAt: NOW,
  appVersion: '0.4.0',
  profile: null,
  base: `/relay/@me/desktop/${id}/`,
  ...patch
})

type Answer = { status: number; body?: unknown } | 'hang' | 'throw'

interface FakeStream extends StreamHandlers {
  url: string
  closed: boolean
}

const memoryStorage = (): StorageLike & { dump(): Record<string, string> } => {
  let data: Record<string, string> = {}
  return {
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data = { ...data, [key]: value }
    },
    removeItem: (key) => {
      const { [key]: _gone, ...rest } = data
      data = rest
    },
    get length() {
      return Object.keys(data).length
    },
    key: (i) => Object.keys(data)[i] ?? null,
    dump: () => data
  }
}

const CONFIG: FleetConfig = { listUrl: '/v2/me/desktops', requireToken: true, seedCacheUrl: null, ...FLEET_TIMINGS }

const harness = (opts: { list: FleetMachine[]; tokens?: Record<string, string>; storage?: ReturnType<typeof memoryStorage>; random?: number }) => {
  let list = opts.list
  const answers = new Map<string, Answer[]>()
  const calls: Array<{ url: string; at: number; headers: Record<string, string> }> = []
  const streams: FakeStream[] = []
  const tokens = { ...(opts.tokens ?? {}) }
  const storage = opts.storage ?? memoryStorage()
  let hidden = false
  const visibility = new Set<() => void>()
  const wakes = new Set<() => void>()

  /** Queue answers for GET <base>api/levels of a machine; the last one repeats. */
  const answer = (id: string, ...queued: Answer[]) => answers.set(id, queued)

  const deps: FleetDeps = {
    fetch: (url, init) => {
      calls.push({ url, at: Date.now(), headers: init.headers ?? {} })
      if (url === CONFIG.listUrl) return Promise.resolve({ status: 200, json: async () => list })
      const id = url.match(/desktop\/([^/]+)\/api\/levels$/)?.[1] ?? ''
      const queue = answers.get(id) ?? [{ status: 200, body: { ...SNAP } }]
      const next = queue.length > 1 ? queue.shift()! : queue[0]
      if (next === 'throw') return Promise.reject(new TypeError('network'))
      if (next === 'hang')
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      return Promise.resolve({ status: next.status, json: async () => (next.body === undefined ? Promise.reject(new Error('not json')) : next.body) })
    },
    openStream: (url, handlers) => {
      const stream: FakeStream = { url, closed: false, ...handlers }
      streams.push(stream)
      return { close: () => void (stream.closed = true) }
    },
    token: (id) => tokens[id] ?? null,
    cache: createFleetCache(storage, () => Date.now()),
    now: () => Date.now(),
    random: () => opts.random ?? 0.5,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    visibility: {
      hidden: () => hidden,
      onChange: (run) => {
        visibility.add(run)
        return () => visibility.delete(run)
      }
    },
    onWake: (run) => {
      wakes.add(run)
      return () => wakes.delete(run)
    }
  }
  const store = createFleetStore(deps, CONFIG)
  const machine = (id: string): StrataMachine => store.getSnapshot().find((m) => m.id === id)!
  const openStreams = (id: string) => streams.filter((s) => !s.closed && s.url.includes(`/desktop/${id}/`))
  const send = (id: string, event: LevelsEvent) => {
    const [stream] = openStreams(id)
    if (!stream) throw new Error(`no open stream for ${id}`)
    stream.onMessage(JSON.stringify(event))
  }
  const levelCalls = (id: string) => calls.filter((c) => c.url.endsWith(`/desktop/${id}/api/levels`))
  return {
    store,
    storage,
    calls,
    streams,
    tokens,
    answer,
    machine,
    openStreams,
    send,
    levelCalls,
    setList: (next: FleetMachine[]) => void (list = next),
    setHidden: (value: boolean) => {
      hidden = value
      for (const run of visibility) run()
    },
    wake: () => {
      for (const run of wakes) run()
    }
  }
}

const settle = () => vi.advanceTimersByTimeAsync(0)
const goLive = async (h: ReturnType<typeof harness>, id: string, snapshot: LevelsSnapshot = SNAP) => {
  await settle()
  h.send(id, { type: 'snapshot', snapshot })
  await settle()
}
const agentEvent = (rev: number, phase: 'thinking' | 'idle' = 'thinking'): LevelsEvent => {
  const workspace = SNAP.workspaces[0]
  return { type: 'agent', rev, workspaceId: workspace.id, agent: { ...workspace.agents[0], phase } }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the fleet store: link states', () => {
  it('goes connecting → live: one snapshot GET, then one stream', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.store.start()
    await settle()
    expect(h.machine('a').link).toBe('connecting')
    expect(h.levelCalls('a')).toHaveLength(1)
    expect(h.openStreams('a')).toHaveLength(1)
    h.send('a', { type: 'snapshot', snapshot: SNAP })
    await settle()
    expect(h.machine('a')).toMatchObject({ link: 'live', stale: false })
    expect(h.machine('a').levels?.rev).toBe(SNAP.rev)
    h.store.stop()
  })

  it('never asks a machine the registry lists as offline, nor one this browser holds no token for', async () => {
    const h = harness({ list: [row('off', { online: false }), row('bare')] })
    h.store.start()
    await settle()
    expect(h.machine('off').link).toBe('offline')
    expect(h.machine('bare').link).toBe('unpaired')
    expect(h.calls.filter((c) => c.url.includes('/api/levels'))).toHaveLength(0)
    expect(h.streams).toHaveLength(0)
  })

  it.each([
    [{ status: 404, body: { error: 'Not found' } }, 'outdated'],
    [{ status: 200 }, 'outdated'],
    [{ status: 200, body: { ...SNAP, v: 2 } }, 'outdated'],
    [{ status: 401, body: { error: 'Unauthorized — open the pairing URL shown on the desktop (it carries ?token=).' } }, 'unpaired'],
    [{ status: 401, body: { error: 'unauthenticated' } }, 'error'],
    [{ status: 503, body: { error: 'no_link' } }, 'offline'],
    [{ status: 504, body: { error: 'timed_out' } }, 'offline'],
    [{ status: 503, body: { error: 'too_many_exchanges' } }, 'connecting'],
    [{ status: 500, body: {} }, 'error'],
    ['throw', 'offline']
  ] as Array<[Answer, string]>)('classifies %j as %s', async (answer, link) => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.answer('a', answer)
    h.store.start()
    await settle()
    expect(h.machine('a').link).toBe(link)
    expect(h.streams).toHaveLength(0)
  })

  it('times a hung snapshot GET out as offline and retries', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.answer('a', 'hang', { status: 200, body: SNAP })
    h.store.start()
    await vi.advanceTimersByTimeAsync(FLEET_TIMINGS.requestTimeoutMs)
    expect(h.machine('a').link).toBe('offline')
    expect(h.store.detail('a')).toBe('timeout')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.levelCalls('a')).toHaveLength(2)
    expect(h.openStreams('a')).toHaveLength(1)
  })

  it('does not dial a refused token again until the token changes', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.answer('a', { status: 401, body: { error: 'Unauthorized' } }, { status: 200, body: SNAP })
    h.store.start()
    await settle()
    expect(h.machine('a').link).toBe('unpaired')
    await vi.advanceTimersByTimeAsync(FLEET_TIMINGS.listRefreshMs * 2)
    expect(h.levelCalls('a')).toHaveLength(1)
    h.tokens.a = `${TOKEN}2`
    h.wake()
    await goLive(h, 'a')
    expect(h.machine('a').link).toBe('live')
  })

  it('rechecks an outdated desktop only after it updates, or on the slow timer', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.answer('a', { status: 404, body: {} }, { status: 200, body: SNAP })
    h.store.start()
    await settle()
    await vi.advanceTimersByTimeAsync(FLEET_TIMINGS.listRefreshMs)
    expect(h.levelCalls('a')).toHaveLength(1)
    h.setList([row('a', { appVersion: '0.5.0' })])
    await vi.advanceTimersByTimeAsync(FLEET_TIMINGS.listRefreshMs)
    expect(h.levelCalls('a')).toHaveLength(2)
    expect(OUTDATED_RECHECK_MS).toBeGreaterThan(FLEET_TIMINGS.listRefreshMs)
  })
})

describe('the fleet store: revs', () => {
  it('folds deltas that land on rev + 1', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.store.start()
    await goLive(h, 'a')
    h.send('a', agentEvent(SNAP.rev + 1))
    await settle()
    const agent = h.machine('a').levels!.workspaces[0].agents[0]
    expect(agent.phase).toBe('thinking')
    expect(h.machine('a').levels!.rev).toBe(SNAP.rev + 1)
  })

  it('drops the stream on a gap and resyncs at once with a fresh snapshot', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.store.start()
    await goLive(h, 'a')
    const [first] = h.openStreams('a')
    h.send('a', agentEvent(SNAP.rev + 2))
    await settle()
    expect(first.closed).toBe(true)
    expect(h.levelCalls('a')).toHaveLength(2)
    expect(h.openStreams('a')).toHaveLength(1)
    expect(h.machine('a').levels!.rev).toBe(SNAP.rev)
  })

  it('backs off when gaps keep coming without a delta landing between them', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.store.start()
    await goLive(h, 'a')
    h.send('a', agentEvent(SNAP.rev + 5))
    await goLive(h, 'a')
    h.send('a', agentEvent(SNAP.rev + 5))
    await settle()
    expect(h.openStreams('a')).toHaveLength(0)
    expect(h.store.detail('a')).toBe('gap')
    expect(h.levelCalls('a')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5))
    expect(h.levelCalls('a')).toHaveLength(3)
  })

  it('treats a stream that opens without a snapshot, or sends garbage, as a gap', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.store.start()
    await settle()
    h.send('a', agentEvent(SNAP.rev + 1))
    await settle()
    expect(h.levelCalls('a')).toHaveLength(2)
    await goLive(h, 'a')
    h.send('a', agentEvent(SNAP.rev + 1))
    h.openStreams('a')[0].onMessage('{not json')
    await settle()
    expect(h.levelCalls('a')).toHaveLength(3)
  })

  it('accepts a snapshot with a LOWER rev: a restarted desktop starts over', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.store.start()
    await goLive(h, 'a', { ...SNAP, rev: 900 })
    h.send('a', { type: 'snapshot', snapshot: { ...SNAP, rev: 1 } })
    h.send('a', agentEvent(2))
    await settle()
    expect(h.machine('a').levels!.rev).toBe(2)
    expect(h.levelCalls('a')).toHaveLength(1)
  })
})

describe('the fleet store: backoff', () => {
  it('waits longer after each failure, never at zero, capped', () => {
    const delays = Array.from({ length: 8 }, (_, i) => backoffDelay(i, 0))
    expect(delays[0]).toBe(500)
    for (let i = 1; i < delays.length; i += 1) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1])
    expect(backoffDelay(30, 0.999)).toBeLessThanOrEqual(30_000)
    expect(backoffDelay(3, 0)).not.toBe(backoffDelay(3, 0.9))
  })

  it('retries an unreachable desktop on a growing, jittered schedule', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN }, random: 0.25 })
    h.answer('a', { status: 503, body: { error: 'no_link' } })
    h.store.start()
    await settle()
    for (let attempt = 0; attempt < 4; attempt += 1) await vi.advanceTimersByTimeAsync(backoffDelay(attempt, 0.25))
    const at = h.levelCalls('a').map((c) => c.at - NOW)
    expect(at).toHaveLength(5)
    const gaps = at.slice(1).map((t, i) => t - at[i])
    expect(gaps).toEqual([0, 1, 2, 3].map((n) => backoffDelay(n, 0.25)))
  })

  it('starts the backoff over once a link has held for a while', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.answer('a', { status: 503, body: { error: 'no_link' } }, { status: 503, body: { error: 'no_link' } }, { status: 200, body: SNAP })
    h.store.start()
    await settle()
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5) + backoffDelay(1, 0.5))
    h.openStreams('a')[0].onMessage(JSON.stringify({ type: 'snapshot', snapshot: SNAP }))
    await vi.advanceTimersByTimeAsync(FLEET_TIMINGS.stableMs)
    const before = h.levelCalls('a').length
    h.openStreams('a')[0].onError()
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5))
    expect(h.levelCalls('a')).toHaveLength(before + 1)
    expect(h.machine('a').link).toBe('connecting')
  })

  it('a dropped stream reads connecting, and offline once it keeps failing', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.store.start()
    await settle()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.openStreams('a')[0].onError()
      expect(h.machine('a').link).toBe('connecting')
      await vi.advanceTimersByTimeAsync(backoffDelay(attempt, 0.5))
    }
    h.openStreams('a')[0].onError()
    expect(h.machine('a').link).toBe('offline')
  })

  it('the network coming back retries at once', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.answer('a', 'throw', 'throw', 'throw', { status: 200, body: SNAP })
    h.store.start()
    await vi.advanceTimersByTimeAsync(backoffDelay(0, 0.5) + backoffDelay(1, 0.5))
    expect(h.levelCalls('a')).toHaveLength(3)
    h.wake()
    await goLive(h, 'a')
    expect(h.machine('a').link).toBe('live')
  })
})

describe('the fleet store: a hidden tab', () => {
  it('keeps streams for a minute hidden, then closes every one', async () => {
    const h = harness({ list: [row('a'), row('b')], tokens: { a: TOKEN, b: TOKEN } })
    h.store.start()
    await goLive(h, 'a')
    await goLive(h, 'b')
    h.setHidden(true)
    await vi.advanceTimersByTimeAsync(FLEET_TIMINGS.hiddenCloseMs - 1)
    expect(h.openStreams('a')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.streams.every((s) => s.closed)).toBe(true)
    expect(h.machine('a')).toMatchObject({ link: 'connecting', stale: true })
    const calls = h.calls.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.calls).toHaveLength(calls)
  })

  it('reopens within a second of the tab becoming visible', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.store.start()
    await goLive(h, 'a')
    h.setHidden(true)
    await vi.advanceTimersByTimeAsync(FLEET_TIMINGS.hiddenCloseMs)
    const shownAt = Date.now()
    h.setHidden(false)
    await settle()
    const reopened = h.levelCalls('a').at(-1)!
    expect(reopened.at - shownAt).toBeLessThan(1_000)
    expect(h.openStreams('a')).toHaveLength(1)
    h.send('a', { type: 'snapshot', snapshot: SNAP })
    await settle()
    expect(h.machine('a').link).toBe('live')
  })

  it('a quick look away closes nothing', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.store.start()
    await goLive(h, 'a')
    h.setHidden(true)
    await vi.advanceTimersByTimeAsync(20_000)
    h.setHidden(false)
    await vi.advanceTimersByTimeAsync(FLEET_TIMINGS.hiddenCloseMs)
    expect(h.openStreams('a')).toHaveLength(1)
    expect(h.levelCalls('a')).toHaveLength(1)
  })
})

describe('the fleet store: last-known cache', () => {
  it('paints the last fleet at once, stale until live', async () => {
    const storage = memoryStorage()
    const first = harness({ list: [row('a'), row('off', { online: false })], tokens: { a: TOKEN }, storage })
    first.store.start()
    await goLive(first, 'a')
    first.store.stop()

    const second = harness({ list: [row('a'), row('off', { online: false })], tokens: { a: TOKEN }, storage })
    second.store.start()
    const painted = second.store.getSnapshot()
    expect(painted.map((m) => m.id)).toEqual(['a', 'off'])
    expect(painted[0]).toMatchObject({ link: 'connecting', stale: true })
    expect(painted[0].levels?.rev).toBe(SNAP.rev)
    await goLive(second, 'a')
    expect(second.machine('a')).toMatchObject({ link: 'live', stale: false })
  })

  it('keeps a machine’s last snapshot through a drop, marked stale', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.store.start()
    await goLive(h, 'a')
    h.openStreams('a')[0].onError()
    expect(h.machine('a')).toMatchObject({ link: 'connecting', stale: true })
    expect(h.machine('a').levels?.rev).toBe(SNAP.rev)
  })

  it('never writes a pairing token into its cache', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.store.start()
    await goLive(h, 'a')
    h.store.stop()
    expect(JSON.stringify(h.storage.dump())).not.toContain(TOKEN)
  })

  it('forgets a machine the registry stopped listing', async () => {
    const h = harness({ list: [row('a'), row('b')], tokens: { a: TOKEN, b: TOKEN } })
    h.store.start()
    await goLive(h, 'b')
    h.setList([row('a')])
    await vi.advanceTimersByTimeAsync(FLEET_TIMINGS.listRefreshMs)
    expect(h.store.getSnapshot().map((m) => m.id)).toEqual(['a'])
    expect(h.openStreams('b')).toHaveLength(0)
    expect(Object.keys(h.storage.dump()).some((k) => k.endsWith(':b'))).toBe(false)
  })
})

describe('the fleet store: tokens on the wire', () => {
  it('sends the token as a header on GETs and only in the stream URL as ?token=', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.store.start()
    await goLive(h, 'a')
    for (const call of h.calls) expect(call.url).not.toContain(TOKEN)
    expect(h.levelCalls('a')[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(h.streams[0].url).toBe(`/relay/@me/desktop/a/api/levels/stream?token=${TOKEN}`)
  })
})

describe('the fleet store: the registry list', () => {
  it('connects a machine as soon as the registry says it came online', async () => {
    const h = harness({ list: [row('a', { online: false })], tokens: { a: TOKEN } })
    h.store.start()
    await settle()
    expect(h.machine('a').link).toBe('offline')
    h.setList([row('a')])
    await vi.advanceTimersByTimeAsync(FLEET_TIMINGS.listRefreshMs)
    expect(h.openStreams('a')).toHaveLength(1)
  })

  it('refuses rows whose base is not a same-origin path', async () => {
    const evil = { ...row('x'), base: 'https://evil.example/' }
    const h = harness({ list: [row('a'), evil as FleetMachine, { ...row('y'), base: '//evil.example/' }], tokens: { a: TOKEN, x: TOKEN, y: TOKEN } })
    h.store.start()
    await settle()
    expect(h.store.getSnapshot().map((m) => m.id)).toEqual(['a'])
  })

  it('hands the same rows array out until something changes', async () => {
    const h = harness({ list: [row('a')], tokens: { a: TOKEN } })
    h.store.start()
    await goLive(h, 'a')
    const one = h.store.getSnapshot()
    expect(h.store.getSnapshot()).toBe(one)
    h.send('a', agentEvent(SNAP.rev + 1))
    await settle()
    expect(h.store.getSnapshot()).not.toBe(one)
  })
})

describe('8 of N online', () => {
  const machine = (id: string, online: boolean, link: StrataMachine['link'] = online ? 'live' : 'offline'): StrataMachine => ({
    ...row(id, { online }),
    link,
    levels: null,
    stale: false
  })

  it('counts the registry’s lines against the cap', () => {
    const fleet = [...Array.from({ length: 8 }, (_, i) => machine(`on${i}`, true)), machine('x', false), machine('y', false), machine('z', false)]
    expect(onlinePicture(fleet)).toMatchObject({ total: 11, online: 8, live: 8, capped: true, label: '8 of 11 online' })
  })

  it('is not capped below the cap', () => {
    expect(onlinePicture([machine('a', true, 'connecting'), machine('b', false)])).toMatchObject({ online: 1, live: 0, capped: false, label: '1 of 2 online' })
  })
})
