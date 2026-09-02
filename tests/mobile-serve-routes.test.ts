import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps, type ServeOps } from '../src/main/mobile-api'

/**
 * IMPORTING A SERVED TEAM FROM THE PHONE.
 *
 * The phone bridge used to refuse every serve call as "desktop-only". The
 * card is placed and spawned at the desktop the phone is a view of, so the
 * refusal was a missing route. These pin that the six verbs reach the
 * desktop's own operations with their arguments intact and their shapes
 * checked, behind the same pairing every write on this API needs.
 */
const TOKEN = 'pairing-token-123'

describe('POST /api/serve/*', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const startApi = async (serve?: ServeOps): Promise<number> => {
    const deps = { pairingToken: TOKEN, ...(serve ? { serve } : {}) } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as net.AddressInfo).port
  }

  const post = async (port: number, verb: string, body: unknown, token = TOKEN) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/serve/${verb}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
  }

  it('reaches every verb with its arguments intact, and validates the shapes it can', async () => {
    const calls: unknown[][] = []
    const serve: ServeOps = {
      inspect: async (link) => (calls.push(['inspect', link]), { ok: true, which: 'inspect' }),
      browse: async (link) => (calls.push(['browse', link]), { ok: true, which: 'browse' }),
      gate: async (link) => (calls.push(['gate', link]), { ok: true, which: 'gate' }),
      checkout: async (link) => (calls.push(['checkout', link]), { ok: true, url: 'https://pay.example/cs_1', session: 'cs_1' }),
      settle: async (link, rail, session) => (calls.push(['settle', link, rail, session]), { ok: true, which: 'settle' }),
      import: async (link, position, paid) => (calls.push(['import', link, position, paid]), { ok: true, node: { id: 'n1', position } })
    }
    const port = await startApi(serve)
    const link = 'https://cookrew.dev/drej/cookrew-alpha'
    expect((await post(port, 'inspect', { link })).body).toEqual({ ok: true, which: 'inspect' })
    expect((await post(port, 'browse', { link: '@drej' })).body).toEqual({ ok: true, which: 'browse' })
    expect((await post(port, 'gate', { link })).body).toEqual({ ok: true, which: 'gate' })
    expect((await post(port, 'checkout', { link })).body).toMatchObject({ ok: true, session: 'cs_1' })
    expect((await post(port, 'settle', { link, rail: 'stripe', session: 'cs_1' })).body).toEqual({ ok: true, which: 'settle' })
    const placed = await post(port, 'import', {
      link,
      position: { x: 40, y: 80 },
      paid: { price: '2.50', asset: 'USDC', rail: 'x402' }
    })
    expect(placed.body).toEqual({ ok: true, node: { id: 'n1', position: { x: 40, y: 80 } } })
    expect(calls).toEqual([
      ['inspect', link],
      ['browse', '@drej'],
      ['gate', link],
      ['checkout', link],
      ['settle', link, 'stripe', 'cs_1'],
      ['import', link, { x: 40, y: 80 }, { price: '2.50', asset: 'USDC', rail: 'x402' }]
    ])
    // Shapes: a NaN position and a malformed receipt are dropped, not passed.
    calls.length = 0
    await post(port, 'import', { link, position: { x: 'left', y: 1 }, paid: { price: 1, rail: 'cash' } })
    expect(calls).toEqual([['import', link, undefined, undefined]])
    // A bad rail and a missing link are refused before anything is called.
    expect((await post(port, 'settle', { link, rail: 'cheque' })).status).toBe(400)
    expect((await post(port, 'gate', {})).status).toBe(400)
    expect((await post(port, 'nonsense', { link })).status).toBe(404)
  })

  it('answers 503 when the desktop has not wired the operations, and refuses an unpaired caller', async () => {
    const port = await startApi()
    expect((await post(port, 'inspect', { link: 'https://cookrew.dev/drej/x' })).status).toBe(503)
    const paired = await startApi({
      inspect: async () => ({ ok: true }),
      browse: async () => ({}),
      gate: async () => ({}),
      checkout: async () => ({}),
      settle: async () => ({}),
      import: async () => ({})
    })
    const stranger = await post(paired, 'inspect', { link: 'https://cookrew.dev/drej/x' }, 'not-the-token')
    expect(stranger.status).toBe(401)
  })
})
