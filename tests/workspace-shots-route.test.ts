import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'

/**
 * GET /api/workspaces/shots — the Mac's pictures of its canvases, for the
 * phone's screen wall. A picture of every workspace is a picture of every
 * task the owner has going, so it sits behind the same read gate as the
 * board; 503 when index.ts has not wired it, so a missing wire-up is loud
 * rather than a wall that quietly says NO SNAPSHOT YET for everything.
 */
const PAIRING = 'pairing-token-123'
const WALL = 'wall-token-456'
const SHOTS = {
  w1: { src: 'data:image/jpeg;base64,AAAA', at: 1_800_000_000_000 },
  w2: { src: 'data:image/jpeg;base64,BBBB', at: 1_800_000_060_000 },
}

describe('GET /api/workspaces/shots', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const startApi = async (over: Partial<MobileApiDeps>): Promise<number> => {
    const deps = { pairingToken: PAIRING, wallToken: WALL, ...over } as unknown as MobileApiDeps
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
    const response = await fetch(`http://127.0.0.1:${port}/api/workspaces/shots`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    })
    const text = await response.text()
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
  }

  it('is refused without a token', async () => {
    const port = await startApi({ workspaceShots: () => SHOTS })
    expect((await get(port)).status).toBe(401)
  })

  it('answers the pictures to a paired phone and to the read-only wall alike', async () => {
    const port = await startApi({ workspaceShots: () => SHOTS })
    expect((await get(port, WALL)).status).toBe(200)
    const paired = await get(port, PAIRING)
    expect(paired.status).toBe(200)
    expect(paired.body).toEqual(SHOTS)
  })

  it('is 503, not an empty wall, when index.ts has not wired it', async () => {
    const port = await startApi({})
    const answer = await get(port, PAIRING)
    expect(answer.status).toBe(503)
    expect(answer.body).toEqual({ error: 'workspace shots not wired' })
  })
})
