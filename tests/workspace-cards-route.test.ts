import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'

/**
 * GET /api/workspaces/:id/cards — a workspace's cards for the world's scenes,
 * read without switching to it. Names and shapes only; behind the same read
 * gate as the board; 503 when index.ts has not wired it, so a missing wire-up
 * is loud rather than an island that quietly has no equipment.
 */
const PAIRING = 'pairing-token-123'
const WALL = 'wall-token-456'
const CARDS = {
  id: 'w1',
  cards: [{ id: 't', kind: 'terminal', name: 'Forge', x: 0, y: 0, w: 320, h: 220 }],
  links: []
}

describe('GET /api/workspaces/:id/cards', () => {
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

  const get = async (port: number, id: string, token?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspaces/${id}/cards`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    })
    const text = await response.text()
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
  }

  it('is refused without a token', async () => {
    const port = await startApi({ workspaceCards: () => CARDS as never })
    expect((await get(port, 'w1')).status).toBe(401)
  })

  it('answers a paired phone and the read-only wall alike, for the id asked', async () => {
    const asked: string[] = []
    const port = await startApi({
      workspaceCards: (id) => {
        asked.push(id)
        return CARDS as never
      }
    })
    expect((await get(port, 'w1', WALL)).status).toBe(200)
    const paired = await get(port, 'w%201', PAIRING)
    expect(paired.status).toBe(200)
    expect(paired.body).toEqual(CARDS)
    expect(asked).toEqual(['w1', 'w 1'])
  })

  it('is 503, not an empty island, when index.ts has not wired it', async () => {
    const port = await startApi({})
    const answer = await get(port, 'w1', PAIRING)
    expect(answer.status).toBe(503)
    expect(answer.body).toEqual({ error: 'workspace cards not wired' })
  })
})
