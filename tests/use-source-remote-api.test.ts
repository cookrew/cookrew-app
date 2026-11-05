// THE PHONE'S SIDE OF THE PICKER (remote-api.ts): the real module on a window
// shim, as remote-relay-full.test.ts does. It asks the routes by their path,
// carries the pairing token, and hands a refusal to the sheet as an answer.
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
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response

const api = async (fetcher: ReturnType<typeof vi.fn>) => {
  vi.stubGlobal('fetch', fetcher)
  const { createRemoteApi } = await import('../src/renderer/src/remote-api')
  return createRemoteApi()
}
const callTo = (fetcher: ReturnType<typeof vi.fn>, path: string) => fetcher.mock.calls.find(([url]) => String(url).endsWith(path))

beforeEach(() => {
  vi.resetModules()
  installWindow()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).window
})

describe('the phone reaches the picker', () => {
  it('lists with its credential', async () => {
    const list = { state: 'ready', windows: [], screens: [], message: null, remote: null, windowsNote: null }
    const fetcher = vi.fn(async () => answer(200, list))
    expect(await (await api(fetcher)).useSources?.()).toEqual(list)
    const [, init] = callTo(fetcher, '/api/use/sources') as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer paired-token')
  })

  it('posts a pick and reads the card back', async () => {
    const card = { id: 'c', name: 'Safari — Docs', url: 'window://Safari?id=4' }
    const fetcher = vi.fn(async () => answer(200, { ok: true, card }))
    expect(await (await api(fetcher)).openUseSource?.({ source: 'window:4' })).toEqual({ ok: true, card })
    const [, init] = callTo(fetcher, '/api/use/sources/open') as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ source: 'window:4' })
  })

  it('a refused pick is an answer the sheet can read out, not a throw', async () => {
    const fetcher = vi.fn(async () => answer(403, { ok: false, error: 'A served session cannot use this Mac' }))
    expect(await (await api(fetcher)).openUseSource?.({ source: 'window:4' })).toEqual({ ok: false, error: 'A served session cannot use this Mac' })
  })

  it('the settings button is a POST to the Mac, naming the page', async () => {
    const fetcher = vi.fn(async () => answer(200, { ok: true }))
    await (await api(fetcher)).openScreenSettings?.('accessibility')
    const [, init] = callTo(fetcher, '/api/use/sources/settings') as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ pane: 'accessibility' })
  })

  it('a refused Take control is an answer the card can read out, with the state it names', async () => {
    const state = { id: 'needs-accessibility', platform: 'darwin', then: null, detail: null, lastSeenAt: null, until: null, waiting: false, build: { settingsName: 'Cookrew', sourceBuild: false, restart: 'self', agents: 'keep' } }
    const fetcher = vi.fn(async () => answer(409, { ok: false, error: 'Accessibility is off', state }))
    expect(await (await api(fetcher)).remoteControl?.({ card: 'c', on: true })).toEqual({ ok: false, error: 'Accessibility is off', state })
  })

  it('a phone has no machine switch and no Stop: there is no route, and no method', async () => {
    const remote = await api(vi.fn(async () => answer(200, {})))
    expect(remote.setRemoteSwitch).toBeUndefined()
    expect(remote.stopRemote).toBeUndefined()
    expect(remote.onRemoteHost).toBeUndefined()
  })
})
