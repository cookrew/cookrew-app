import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'

/**
 * GET /api/terminal-session — whether the terminals' herdr server predates this
 * macOS login (main/terminal-session.ts), so the phone's card says it too.
 * Behind the pairing token; 503 when index.ts has not wired it.
 */
const PAIRING = 'pairing-token-123'
const STALE = { stale: true, serverPid: 1201, serverStartedAt: 1_793_294_889_000, loginAt: 1_793_449_721_000 }

describe('GET /api/terminal-session', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })
  const startApi = async (over: Partial<MobileApiDeps>): Promise<number> => {
    const deps = { pairingToken: PAIRING, ...over } as unknown as MobileApiDeps
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
  const get = async (port: number, token?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/terminal-session`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  it('answers a paired phone', async () => {
    const port = await startApi({ terminalSession: async () => STALE })
    expect(await get(port, PAIRING)).toEqual({ status: 200, body: STALE })
  })

  it('is refused without a token', async () => {
    const port = await startApi({ terminalSession: async () => STALE })
    expect((await get(port)).status).toBe(401)
  })

  it('is loud when not wired', async () => {
    expect((await get(await startApi({}), PAIRING)).status).toBe(503)
  })
})
