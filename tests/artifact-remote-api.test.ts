// THE PHONE ASKS FOR AN ARTIFACT (remote-api.ts · artifactView): by its route,
// with its credential, through the same plane as every other read.
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

const load = async (fetcher: ReturnType<typeof vi.fn>) => {
  vi.stubGlobal('fetch', fetcher)
  return import('../src/renderer/src/remote-api')
}

beforeEach(() => {
  vi.resetModules()
  installWindow()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).window
})

describe('artifactView', () => {
  it('asks the artifact route for the card, encoded, with the pairing token', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ kind: 'note', name: 'n', title: 't', markdown: 'm' }), { headers: { 'content-type': 'application/json' } }))
    const { artifactView } = await load(fetcher)
    expect(await artifactView('card/1 x')).toEqual({ kind: 'note', name: 'n', title: 't', markdown: 'm' })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/api/artifact/card%2F1%20x')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer paired-token')
  })

  it('reads a file card as bytes', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }))
    const { artifactView } = await load(fetcher)
    const view = await artifactView('c', 'chart.png')
    expect(view.kind).toBe('file')
    if (view.kind === 'file') expect([...new Uint8Array(view.bytes)]).toEqual([1, 2, 3])
  })

  it('a missing card is a refusal the sheet can read out', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'No such card.' }), { status: 404, headers: { 'content-type': 'application/json' } }))
    const { artifactView } = await load(fetcher)
    await expect(artifactView('gone')).rejects.toThrow('No such card.')
  })
})
