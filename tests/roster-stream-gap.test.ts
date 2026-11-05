// A roster frame sent while the phone's stream was down is gone for good.
//
// Measured 2026-11-05: Box QA slept at 02:34 and a dispatch woke it at 10:36,
// while the phone was asleep. The registry said active, /api/activity said
// thinking and the card's own spinner read "46m 32s" to the second, yet the
// card said OFFLINE: the roster on the page was the one from before the gap,
// and phaseOf reads `active` first. The stream opens with the workspace and
// the activity on every reconnect, but the roster only ever came as changes.
//
// Asserted against the real remote-api and ReconnectingStream; only the
// browser's EventSource and fetch are stood in for.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STREAM_CONNECTING = 0
const STREAM_OPEN = 1
const STREAM_CLOSED = 2

class FakeEventSource extends EventTarget {
  static made: FakeEventSource[] = []
  readyState = STREAM_CONNECTING
  onerror: ((event: Event) => void) | null = null
  constructor(readonly url: string) {
    super()
    FakeEventSource.made.push(this)
  }
  close(): void {
    this.readyState = STREAM_CLOSED
  }
  open(): void {
    this.readyState = STREAM_OPEN
    this.dispatchEvent(new Event('open'))
  }
  /** Gone for good: the client's own backoff has to bring it back. */
  die(): void {
    this.readyState = STREAM_CLOSED
    this.dispatchEvent(new Event('error'))
  }
  /** Dropped, and the browser is redialling by itself: no state for the client to act on. */
  drop(): void {
    this.readyState = STREAM_CONNECTING
    this.dispatchEvent(new Event('error'))
  }
}

function installWindow(): void {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage: storage,
    sessionStorage: storage,
    location: { search: '?token=paired-token', href: 'https://phone.local/' },
    history: { replaceState: () => undefined }
  }
}

const agent = (active: boolean): { id: string; active: boolean } => ({ id: 'box-qa', active })

function respond(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  } as unknown as Response
}

const rosterPulls = (fetcher: ReturnType<typeof vi.fn>): number =>
  fetcher.mock.calls.filter(([url]) => String(url).includes('/api/agents')).length

/** The page as a phone holds it: subscribed, and its stream dialled. */
async function page(fetcher: ReturnType<typeof vi.fn>): Promise<{ lists: unknown[][]; off: () => void; first: FakeEventSource }> {
  vi.stubGlobal('fetch', fetcher)
  const { createRemoteApi } = await import('../src/renderer/src/remote-api')
  const api = createRemoteApi()
  const lists: unknown[][] = []
  // useRoster subscribes to both, and a subscriber is what dials the stream.
  api.onAgentChanged?.(() => undefined)
  const off = api.onAgentRegistry?.((list) => void lists.push(list)) ?? (() => undefined)
  return { lists, off, first: FakeEventSource.made[0] }
}

const latest = (): FakeEventSource => FakeEventSource.made[FakeEventSource.made.length - 1]

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  installWindow()
  FakeEventSource.made = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the roster after a gap in the stream', () => {
  it('leaves the first connect to the pull the page already made', async () => {
    const fetcher = vi.fn(async () => respond({ agents: [agent(true)] }))
    const { first } = await page(fetcher)
    first.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(rosterPulls(fetcher)).toBe(0)
  })

  it('pulls the roster again when the client brings a dead stream back', async () => {
    const fetcher = vi.fn(async () => respond({ agents: [agent(true)] }))
    const { lists, first } = await page(fetcher)
    first.open()
    first.die()
    await vi.advanceTimersByTimeAsync(1000)
    latest().open()
    await vi.advanceTimersByTimeAsync(0)
    expect(lists).toEqual([[agent(true)]])
  })

  it('pulls the roster again when the browser redials by itself', async () => {
    // No CLOSED state, so the client never hears the stream went down: the
    // only sign of the gap is a second open on the same source.
    const fetcher = vi.fn(async () => respond({ agents: [agent(true)] }))
    const { lists, first } = await page(fetcher)
    first.open()
    first.drop()
    first.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(lists).toEqual([[agent(true)]])
  })

  it('pulls when the very first connect failed, since the page pull most likely did too', async () => {
    const fetcher = vi.fn(async () => respond({ agents: [agent(true)] }))
    const { lists, first } = await page(fetcher)
    first.die()
    await vi.advanceTimersByTimeAsync(1000)
    latest().open()
    await vi.advanceTimersByTimeAsync(0)
    expect(lists).toEqual([[agent(true)]])
  })

  it('keeps the roster it holds when the pull fails, and takes the next one', async () => {
    const fetcher = vi.fn(async () => respond({ error: 'boom' }, 500))
    const { lists, first } = await page(fetcher)
    first.open()
    first.drop()
    first.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(rosterPulls(fetcher)).toBe(1)
    expect(lists).toEqual([])

    fetcher.mockImplementation(async () => respond({ agents: [agent(true)] }))
    first.drop()
    first.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(lists).toEqual([[agent(true)]])
  })

  it('stops pulling once unsubscribed', async () => {
    const fetcher = vi.fn(async () => respond({ agents: [agent(true)] }))
    const { off, first } = await page(fetcher)
    first.open()
    off()
    first.drop()
    first.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(rosterPulls(fetcher)).toBe(0)
  })
})
