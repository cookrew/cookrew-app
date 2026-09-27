import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'

/**
 * The lane routes are the desktop's own operations over HTTP, so LAND from
 * the phone is one code path. Behind the read gate like every /api GET, the
 * write gate like every POST; an operation's refusal is a 400 in its words.
 */
const PAIRING = 'pairing-token-123'
const WALL = 'wall-token-456'

describe('/api/lanes', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })
  const calls: unknown[][] = []
  const ops = {
    laneList: async (dir: string) => {
      calls.push(['list', dir])
      return [{ path: dir, branch: 'dev', base: 'dev', isMain: true, dirty: false, conflicts: [], ahead: 0, behind: 0 }]
    },
    laneOpen: async (nodeId: string, name: string) => {
      calls.push(['open', nodeId, name])
      if (!name) throw new Error('Worktree needs a name')
      return { id: nodeId, kind: 'terminal', cwd: `/r/.claude/worktrees/${name}` }
    },
    laneLand: async (nodeId: string, opts: unknown) => {
      calls.push(['land', nodeId, opts])
      return { ok: true, landed: 'abc1234', commits: 2, closed: false }
    },
    laneClose: async (nodeId: string) => ({ id: nodeId }),
    laneAuto: (nodeId: string, on: boolean) => ({ id: nodeId, laneAutoLand: on }),
  }

  const startApi = async (): Promise<number> => {
    const deps = { pairingToken: PAIRING, wallToken: WALL, ops } as unknown as MobileApiDeps
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
  const call = async (port: number, path: string, token?: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : {} }
  }

  it('lists lanes to a reader and refuses without a token', async () => {
    const port = await startApi()
    expect((await call(port, '/api/lanes?dir=/r')).status).toBe(401)
    const listed = await call(port, '/api/lanes?dir=/r', WALL)
    expect(listed.status).toBe(200)
    expect(listed.body[0].isMain).toBe(true)
  })

  it('lands from the phone with the same operation the desktop uses', async () => {
    const port = await startApi()
    const landed = await call(port, '/api/lanes/land', PAIRING, { nodeId: 'n1', close: true })
    expect(landed.status).toBe(200)
    expect(landed.body).toMatchObject({ ok: true, commits: 2 })
    expect(calls.at(-1)).toEqual(['land', 'n1', { close: true, gate: undefined }])
  })

  it('refuses a write to the read-only wall token', async () => {
    const port = await startApi()
    expect((await call(port, '/api/lanes/land', WALL, { nodeId: 'n1' })).status).toBe(401)
  })

  it('answers an operation’s refusal as 400 in its own words', async () => {
    const port = await startApi()
    const opened = await call(port, '/api/lanes/open', PAIRING, { nodeId: 'n1', name: '' })
    expect(opened.status).toBe(400)
    expect(opened.body.error).toBe('Worktree needs a name')
  })

  it('turns auto-land on and off', async () => {
    const port = await startApi()
    const on = await call(port, '/api/lanes/auto', PAIRING, { nodeId: 'n1', on: true })
    expect(on.body).toEqual({ id: 'n1', laneAutoLand: true })
  })
})
