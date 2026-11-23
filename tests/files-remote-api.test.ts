import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', {
    localStorage: storage,
    sessionStorage: storage,
    location: { search: '?token=paired-token', href: 'https://phone.local/' },
    history: { replaceState: () => undefined }
  })
})

afterEach(() => vi.unstubAllGlobals())

const load = async (fetcher: ReturnType<typeof vi.fn>) => {
  vi.stubGlobal('fetch', fetcher)
  return import('../src/renderer/src/remote-api')
}

describe('Files API', () => {
  const root = { path: '/shared/A & B', name: 'A & B' }

  it('lists roots and folders through the paired, seated API', async () => {
    const folder = { path: 'A+B/100%', entries: [], truncated: false }
    const fetcher = vi.fn<(path: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ roots: [root] }))
      .mockResolvedValueOnce(Response.json(folder))
    const { filesRoots, filesList } = await load(fetcher)
    const { takeSeat } = await import('../src/renderer/src/device-seat')
    takeSeat('seat/1')
    expect(await filesRoots()).toEqual({ roots: [root] })
    expect(await filesList(root.path, folder.path)).toEqual(folder)
    for (const [path, init] of fetcher.mock.calls) {
      expect(new URL(path, 'https://phone.local').searchParams.get('seat')).toBe('seat/1')
      expect(init.headers).toMatchObject({ authorization: 'Bearer paired-token' })
    }
    const requested = new URL(fetcher.mock.calls[1][0], 'https://phone.local')
    expect(requested.pathname).toBe('/api/files/list')
    expect(requested.searchParams.get('root')).toBe(root.path)
    expect(requested.searchParams.get('path')).toBe(folder.path)
  })

  it('treats raw JSON as file bytes even with hidden route headers', async () => {
    const text = JSON.stringify({ kind: 'link', name: 'A link', url: 'https://example.com/' })
    const { filesRaw } = await load(vi.fn(async () => new Response(text, { headers: { 'content-type': 'application/json' } })))
    const raw = await filesRaw(root.path, 'folder/payload.json')
    expect(raw).toMatchObject({ kind: 'file', name: 'payload.json', mime: 'application/json' })
    if ('kind' in raw) expect(new TextDecoder().decode(raw.bytes)).toBe(text)
  })

  it('uses the file name and hash sent in the headers', async () => {
    const hash = 'a'.repeat(64)
    const { filesRaw } = await load(vi.fn(async () => new Response('%PDF', { headers: {
      'content-type': 'application/pdf', 'x-cookrew-file': 'The%20report.pdf', etag: `"${hash}"`
    } })))
    expect(await filesRaw(root.path, 'alias')).toMatchObject({ kind: 'file', name: 'The report.pdf', hash, mime: 'application/pdf' })
  })

  it('rejects a malformed listing before it reaches the sheet', async () => {
    const { filesList } = await load(vi.fn(async () => Response.json({ path: '', entries: null, truncated: false })))
    await expect(filesList(root.path, '')).rejects.toThrow('Invalid folder listing')
  })

  it('a refusal without a why reads as plain words, not a status code', async () => {
    const { filesRoots } = await load(vi.fn(async () => new Response('bad gateway', { status: 502 })))
    const result = await filesRoots()
    expect('why' in result && result.why).toMatch(/did not answer/)
    expect('why' in result && result.why).not.toMatch(/502/)
  })

  it('passes the caller abort signal to the read, so leaving a file stops its download', async () => {
    const fetcher = vi.fn(async () => Response.json({ roots: [] }))
    const { filesRoots } = await load(fetcher)
    const controller = new AbortController()
    await filesRoots(controller.signal)
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeDefined()
  })

  it.each([401, 403, 404, 413])('returns the structured refusal on %i', async (status) => {
    const refusal = { error: 'refused', why: 'The computer did not send the file.' }
    const { filesRaw } = await load(vi.fn(async () => Response.json(refusal, { status })))
    expect(await filesRaw(root.path, 'file')).toEqual(refusal)
  })
})
