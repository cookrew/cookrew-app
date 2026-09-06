import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import type { LoopHealthSnapshot } from '../src/main/loop-health'

/**
 * GET /api/health — the main process reading its own event loop for the
 * perf eval. Behind the same read gate as every other /api GET (pairing OR
 * wall token), 503 when index.ts has not wired it, and its body is timings
 * and counts only: nothing in it can be a token.
 */
const PAIRING = 'pairing-token-123'
const WALL = 'wall-token-456'

const snapshot: LoopHealthSnapshot = {
  now: 1_800_000_000_000,
  uptimeMs: 1000,
  windowMs: 60_000,
  loop: {
    lastMinute: { at: 1, elapsedMs: 60_000, samples: 3000, p50: 0.4, p95: 12, p98: 40, max: 2600, elu: 0.31 },
    current: { at: 2, elapsedMs: 100, samples: 5, p50: 0.4, p95: 0.5, p98: 0.5, max: 0.6, elu: 0.02 },
    windows: []
  },
  loops: { boardProbe: { count: 20, p50: 88, p95: 2400, max: 5100, lastMs: 90, lastAt: 3 } },
  residency: { store: 3, registry: 3 }
}

describe('GET /api/health', () => {
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
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    })
    const text = await response.text()
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, text }
  }

  it('is refused without a token', async () => {
    const port = await startApi({ health: () => snapshot })
    expect((await get(port)).status).toBe(401)
  })

  it('answers the read-only wall token as well as the pairing token', async () => {
    const port = await startApi({ health: () => snapshot })
    expect((await get(port, WALL)).status).toBe(200)
    const paired = await get(port, PAIRING)
    expect(paired.status).toBe(200)
    expect(paired.body).toEqual(snapshot)
    expect(paired.text).not.toContain(PAIRING)
    expect(paired.text).not.toContain(WALL)
  })

  it('is 503, not an invented all-clear, when index.ts has not wired it', async () => {
    const port = await startApi({})
    const answer = await get(port, PAIRING)
    expect(answer.status).toBe(503)
    expect(answer.body).toEqual({ error: 'health not wired' })
  })
})
