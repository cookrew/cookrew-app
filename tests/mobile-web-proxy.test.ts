import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { PROXY_PAGE_MIME, PROXY_SHIM, proxyPath } from '../src/shared/web-proxy'

const CARD = 'card-1'
const PAGE = 'https://shop.example/folder/page'
const PAIRING = 'owner-pairing'
const WALL = 'wall-pairing'
const upstream = vi.fn<typeof fetch>()
const cookiesFor = vi.fn(async (_url: string) => [{ name: 'sid', value: 'chrome', domain: '.shop.example' }])
let server: http.Server | undefined

async function start() {
  const deps = {
    pairingToken: PAIRING,
    wallToken: WALL,
    scope: 'scoped-workspace',
    store: {
      focusedState: { nodes: [] },
      workspaceState: (id: string) => ({ nodes: id === 'scoped-workspace' ? [{ id: CARD, kind: 'browser', url: PAGE }] : [] })
    },
    webProxy: { session: async () => ({ cookiesFor }), fetch: upstream }
  } as unknown as MobileApiDeps
  const listener = http.createServer((request, response) => {
    void handleMobileApi(request, response, new URL(request.url ?? '/', 'http://localhost'), deps).then((handled) => {
      if (!handled) response.writeHead(404).end()
    })
  })
  server = listener
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
  return (target = PAGE, { token = PAIRING, card = CARD, method = 'GET', query = '' } = {}) =>
    fetch(base + proxyPath(card, target) + query, { method, headers: token ? { authorization: `Bearer ${token}` } : {} })
}

afterEach(async () => {
  const listener = server
  server = undefined
  if (listener) await new Promise<void>((resolve) => listener.close(() => resolve()))
  cookiesFor.mockClear()
  upstream.mockReset()
})

describe('/api/proxy', () => {
  it('requires owner pairing for GET and HEAD', async () => {
    const call = await start()
    expect((await call(PAGE, { token: '' })).status).toBe(401)
    expect((await call(PAGE, { token: WALL })).status).toBe(401)
    expect((await call(PAGE, { token: WALL, method: 'HEAD' })).status).toBe(401)
    expect((await call(PAGE, { token: '', query: `?token=${PAIRING}` })).status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('refuses a blocked target and a card outside the requested workspace', async () => {
    const call = await start()
    const blocked = await call('http://127.0.0.1/')
    expect(blocked.status).toBe(403)
    expect(await blocked.text()).toMatch(/allowed|blocked/i)
    expect((await call(PAGE, { card: 'other-card' })).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('rewrites HTML and isolates it with response headers', async () => {
    upstream.mockResolvedValue(new Response('<html lang="en"><body><img src="/pic.png"></body></html>', {
      headers: {
        'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': '1',
        'set-cookie': 'sid=upstream', 'x-frame-options': 'DENY', 'content-security-policy': 'default-src none',
        'content-security-policy-report-only': 'default-src none', etag: '"upstream"'
      }
    }))
    const call = await start()
    const response = await call()
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain(`data-cookrew-proxy-card="${CARD}"`)
    expect(text).toContain(`src="${proxyPath(CARD, 'https://shop.example/pic.png')}"`)
    expect(text).toContain(`<script data-cookrew-proxy-shim="">${PROXY_SHIM}</script></body>`)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('etag')).toBe('"upstream"')
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(text)))
    for (const header of ['set-cookie', 'content-encoding', 'x-frame-options', 'content-security-policy-report-only']) {
      expect(response.headers.has(header), header).toBe(false)
    }
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-forms allow-popups')
  })

  it('uses the card cookie on same-site hops and never on a CDN', async () => {
    const cdn = 'https://cdn.other.example/pic.png'
    upstream.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: cdn } }))
    upstream.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }))
    const call = await start()
    const response = await call()
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3])
    expect(response.headers.get('cache-control')).toBe('private, max-age=60')
    expect(cookiesFor.mock.calls).toEqual([[PAGE]])
    expect(new Headers(upstream.mock.calls[0][1]?.headers).get('cookie')).toBe('sid=chrome')
    expect(String(upstream.mock.calls[1][0])).toBe(cdn)
    expect(new Headers(upstream.mock.calls[1][1]?.headers).has('cookie')).toBe(false)
  })

  it('checks the redirect destination before opening another connection', async () => {
    upstream.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }))
    const call = await start()
    expect((await call()).status).toBe(403)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('keeps a frame read within its origin across redirects', async () => {
    const startUrl = 'https://cdn.other.example/asset.css'
    upstream.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: PAGE } }))
    const call = await start()
    const query = `?origin=${encodeURIComponent(new URL(startUrl).origin)}&cookies=omit&format=frame`
    expect((await call(startUrl, { query })).status).toBe(403)
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(cookiesFor).not.toHaveBeenCalled()
  })

  it('wraps the page as relay-safe data and rewrites decoded HTML attributes', async () => {
    upstream.mockResolvedValueOnce(new Response('<a href="/q?p=1&amp;k=2">Next</a>', {
      headers: { 'content-type': 'text/html' }
    })).mockResolvedValueOnce(new Response(JSON.stringify({ html: 'untrusted payload' }), {
      headers: { 'content-type': PROXY_PAGE_MIME }
    }))
    const call = await start()
    const query = '?format=frame'
    const response = await call(PAGE, { query })
    expect(response.headers.get('content-type')).toBe(PROXY_PAGE_MIME)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ html: expect.stringContaining(proxyPath(CARD, 'https://shop.example/q?p=1&k=2')) })
    expect((await call(PAGE, { query })).headers.get('content-type')).toBe('application/octet-stream')
  })

  it('sanitizes upstream errors and supports HEAD without a response body', async () => {
    upstream.mockResolvedValueOnce(new Response('upstream detail', { status: 503 }))
    upstream.mockRejectedValueOnce(new Error('private network detail'))
    upstream.mockResolvedValueOnce(new Response(null, { headers: { 'content-type': 'text/css', 'content-length': '999' } }))
    const call = await start()
    for (const detail of ['upstream detail', 'private network detail']) {
      const failed = await call()
      expect(failed.status).toBe(502)
      expect(await failed.text()).not.toContain(detail)
    }
    const head = await call('https://shop.example/site.css', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(upstream.mock.calls[2][1]?.method).toBe('HEAD')
  })
})
