// THE PHONE'S COMMIT: WHO IT IS BOUND TO, AND WHAT A SECOND COMMIT HEARS (R3, round 3).
//
// Round 2 bound a caller-less commit to the socket address — but a dual-stack
// phone roams between v4 and v6 and between Wi-Fi and the tailnet mid-hold,
// so the token it minted on one address was refused from the next. And a
// commit that arrived while the first was landing was answered 410 "expired",
// which reads as a stale box when the brief is in fact on its way.

import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import type { Caller } from '../src/main/sous-control'

const TOKEN = 'pairing-token-123'

describe('/api/sous/commit — the caller and the in-flight answer', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const startApi = async (error?: 'bad-target' | 'expired' | 'not-yours' | 'in-flight') => {
    const callers: Array<Caller | undefined> = []
    const deps = {
      pairingToken: TOKEN,
      turns: { list: () => [] },
      sous: {
        handle: async () => ({ intent: 'none', spoken: '' }),
        commit: async (_token: string, _choice: unknown, caller?: Caller) => {
          callers.push(caller)
          return error ? { intent: 'refused', spoken: 'no', error } : { intent: 'ask', spoken: 'Sent to Forge' }
        },
        cancel: (_token: string, caller?: Caller) => {
          callers.push(caller)
          return true
        }
      }
    } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { port: (server.address() as net.AddressInfo).port, callers }
  }

  const post = async (port: number, path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body)
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
  }

  it('a commit without a callerId carries NO caller — the token is not bound to the socket address', async () => {
    const api = await startApi()
    const out = await post(api.port, '/api/sous/commit', { token: 'tok' })
    expect(out.status).toBe(200)
    expect(api.callers).toEqual([undefined])
  })

  it('a commit with a callerId is bound to it, on the phone surface by default', async () => {
    const api = await startApi()
    await post(api.port, '/api/sous/commit', { token: 'tok', callerId: '  install-7  ' })
    await post(api.port, '/api/sous/cancel', { token: 'tok', callerId: 'install-7', surface: 'phone' })
    expect(api.callers).toEqual([
      { surface: 'phone', callerId: 'install-7' },
      { surface: 'phone', callerId: 'install-7' }
    ])
  })

  it('a cancel without a callerId carries no caller either', async () => {
    const api = await startApi()
    const out = await post(api.port, '/api/sous/cancel', { token: 'tok' })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ cancelled: true })
    expect(api.callers).toEqual([undefined])
  })

  it('a commit while the first is landing is 409, distinct from 410 expired', async () => {
    const inFlight = await startApi('in-flight')
    expect((await post(inFlight.port, '/api/sous/commit', { token: 'tok' })).status).toBe(409)
    const expired = await startApi('expired')
    expect((await post(expired.port, '/api/sous/commit', { token: 'tok' })).status).toBe(410)
    const notYours = await startApi('not-yours')
    expect((await post(notYours.port, '/api/sous/commit', { token: 'tok', callerId: 'b' })).status).toBe(403)
    const badTarget = await startApi('bad-target')
    expect((await post(badTarget.port, '/api/sous/commit', { token: 'tok', target: 'x' })).status).toBe(400)
  })
})
