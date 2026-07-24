import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchRendererDevResource,
  rendererDevPathAllowed,
  rendererDevTarget
} from '../src/main/renderer-dev-proxy'

afterEach(() => vi.unstubAllGlobals())

describe('renderer dev proxy', () => {
  it('allows only the Vite index and module graph', () => {
    expect(rendererDevPathAllowed('/')).toBe(true)
    expect(rendererDevPathAllowed('/src/main.tsx')).toBe(true)
    expect(rendererDevPathAllowed('/@vite/client')).toBe(true)
    expect(rendererDevPathAllowed('/@fs/workspace/node_modules/react.js')).toBe(true)
    expect(rendererDevPathAllowed('/node_modules/.vite/deps/react.js')).toBe(true)
    expect(rendererDevPathAllowed('/api/workspace')).toBe(false)
    expect(rendererDevPathAllowed('/lite')).toBe(false)
  })

  it('keeps every request on the configured Vite origin', () => {
    expect(rendererDevTarget('http://localhost:5173', '/src/main.tsx', '?t=1')?.href).toBe(
      'http://localhost:5173/src/main.tsx?t=1'
    )
    expect(rendererDevTarget('http://localhost:5173', '//other.test/escape')?.origin).toBe(
      'http://localhost:5173'
    )
    expect(rendererDevTarget('file:///tmp/renderer', '/src/main.tsx')).toBeNull()
  })

  it('returns Vite-transformed bytes and content type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('export const current = true', {
        status: 200,
        headers: { 'content-type': 'text/javascript' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const resource = await fetchRendererDevResource(
      'http://localhost:5173',
      '/src/main.tsx',
      '?t=2'
    )

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://localhost:5173/src/main.tsx?t=2'),
      { redirect: 'error', signal: expect.any(AbortSignal) }
    )
    expect(resource?.contentType).toBe('text/javascript')
    expect(resource?.body.toString('utf8')).toBe('export const current = true')
  })

  it('falls back cleanly when Vite is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(
      fetchRendererDevResource('http://localhost:5173', '/src/main.tsx')
    ).resolves.toBeNull()
  })

  it('never sends an API route to Vite', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      fetchRendererDevResource('http://localhost:5173', '/api/workspace')
    ).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
