// THE WIRING (remote-api.ts): reads, writes and taps while the relay is full.
// Runs the real module on a window shim, as remote-auth-errors.test.ts does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const answer = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  }) as unknown as Response

const FULL = { error: 'too_many_exchanges', message: 'That Mac is already carrying 16 requests through the relay.' }
const LIST = { workspaces: [], activeId: 'w1' }
const WORDS = 'The Mac is not answering right now. Try again in a moment.'
const isList = (url: unknown): boolean => String(url).endsWith('/api/workspaces')

/** The switches among a fetcher's calls: createRemoteApi also asks what its credential is worth. */
const switches = (fetcher: ReturnType<typeof vi.fn>): number =>
  fetcher.mock.calls.filter(([url]) => String(url).includes('/api/workspaces/switch')).length

const api = async (): Promise<ReturnType<typeof import('../src/renderer/src/remote-api').createRemoteApi>> => {
  const { createRemoteApi } = await import('../src/renderer/src/remote-api')
  return createRemoteApi()
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  installWindow()
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>).window
  vi.unstubAllGlobals()
})

describe('a read while the relay is full', () => {
  it('waits and gets its answer, with no error to read', async () => {
    let refused = false
    const fetcher = vi.fn(async (url: string) => {
      if (!isList(url) || refused) return answer(200, LIST)
      refused = true
      return answer(503, FULL)
    })
    vi.stubGlobal('fetch', fetcher)
    const reading = (await api()).listWorkspaces()
    await vi.advanceTimersByTimeAsync(1000)
    await expect(reading).resolves.toEqual(LIST)
    expect(fetcher.mock.calls.filter(([url]) => isList(url))).toHaveLength(2)
  })

  it('says so in words when it stays full', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(503, FULL)))
    const reading = (await api()).listWorkspaces()
    const failed = expect(reading).rejects.toMatchObject({ status: 503, message: WORDS })
    await vi.advanceTimersByTimeAsync(15_000)
    await failed
  })
})

describe('a write while the relay is full', () => {
  it('is not asked again, so it cannot land after a newer one', async () => {
    const fetcher = vi.fn(async () => answer(503, FULL))
    vi.stubGlobal('fetch', fetcher)
    const opening = (await api()).switchWorkspace('w1')
    const failed = expect(opening).rejects.toMatchObject({ status: 503, message: WORDS })
    await vi.advanceTimersByTimeAsync(15_000)
    await failed
    expect(switches(fetcher)).toBe(1)
  })
})

describe('a Mac that is really gone', () => {
  it('keeps its own failure', async () => {
    const fetcher = vi.fn(async () => answer(503, { error: 'no_link' }))
    vi.stubGlobal('fetch', fetcher)
    await expect((await api()).switchWorkspace('w1')).rejects.toMatchObject({ status: 503, message: 'no_link' })
    expect(switches(fetcher)).toBe(1)
  })
})

describe('tapping a tile again before the Mac answers', () => {
  it('stays one request', async () => {
    const hung = new Promise<Response>(() => undefined)
    const fetcher = vi.fn(() => hung)
    vi.stubGlobal('fetch', fetcher)
    const remote = await api()
    void remote.switchWorkspace('w1')
    void remote.switchWorkspace('w1')
    void remote.switchWorkspace('w1')
    await vi.advanceTimersByTimeAsync(0)
    expect(switches(fetcher)).toBe(1)
  })
})
