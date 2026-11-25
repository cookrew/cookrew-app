// A WATCH PAIRS WHILE "RELAY: SEALED ONLY" IS ON (owner 2026-11-25). The watch seals in device mode
// with the Mac's key, which it gets only in the claim's answer, so the claim is the one plain call the
// switch lets through on the relay line (seal-marks.ts · passesSealedOnly). Through the Mac's own
// handler (mobile-server.ts · handle), with the relay line's proof on every request.
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handle, type MobileServerDeps } from '../src/main/mobile-server'
import { createSealMarks, passesSealedOnly, SEALED_ONLY_ERROR } from '../src/main/seal-marks'
import { relayLineHeaders } from '../src/main/seal-proof'
import { setWatchHost, type WatchHost } from '../src/main/watch-routes'

const TOKEN = 'canary-watch-claim-token-6c1e9a77'
const OWNER = 'canary-owner-pairing-token-1f2e3d'

describe('passesSealedOnly', () => {
  it('only a POST to the claim', () => {
    expect(passesSealedOnly('POST', '/api/watch/claim')).toBe(true)
    expect(passesSealedOnly('GET', '/api/watch/claim')).toBe(false)
    expect(passesSealedOnly('POST', '/api/watch/claim/')).toBe(false)
    expect(passesSealedOnly('POST', '/api/watch/rekey')).toBe(false)
    expect(passesSealedOnly('POST', '/api/watch/new')).toBe(false)
    expect(passesSealedOnly(undefined, '/api/watch/claim')).toBe(false)
  })
})

describe('the Mac with sealed only on', () => {
  let dir: string
  let server: Server
  let origin: string
  const claimed: (string | null)[] = []

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'watch-sealed-only-'))
    const marks = createSealMarks(path.join(dir, 'seal-marks.json'))
    marks.setSealedOnly(true)
    setWatchHost({
      pairing: {
        claim: (code: unknown, device: string | null) => {
          claimed.push(device)
          return code === 'GOOD-CODE' ? { ok: true, token: TOKEN } : { ok: false, reason: 'wrong' }
        },
        accepts: () => false
      },
      desktopName: () => 'MacBook Pro',
      bases: () => []
    } as unknown as WatchHost)
    const deps = {
      multiInstance: () => false,
      store: { focusedId: 'w1', focusedState: { nodes: [], edges: [] }, workspaceState: () => ({ nodes: [], edges: [] }), list: () => ({ workspaces: [] }), bySlug: () => undefined, on: () => () => undefined },
      ptys: { get: () => null, on: () => () => undefined },
      turns: { list: () => [], on: () => () => undefined },
      activity: { on: () => () => undefined },
      events: { on: () => () => undefined },
      ops: { listWorkspaces: () => [], onUiCommand: () => () => undefined },
      presets: [],
      traces: { latestCheckpoint: () => null },
      interactiveBrowserEnabled: () => false,
      pairingToken: OWNER,
      wallToken: 'canary-wall',
      perDeviceOnly: () => false,
      rendererDir: '/nonexistent',
      sealMarks: () => marks,
      identity: { account: () => null, registryOrigin: () => 'https://cookrew.dev', admitted: { accepts: () => false, deviceFor: () => null, has: () => false, record: () => undefined } }
    } as unknown as MobileServerDeps
    server = createServer((request, response) => {
      handle(request, response, deps).catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500)
        response.end(String(error))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    setWatchHost(null)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  const relayed = (route: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${origin}${route}`, { ...init, headers: { ...relayLineHeaders(), 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } })

  it('answers a watch\'s claim on the relay line: the one way it gets the key it seals with', async () => {
    const reply = await relayed('/api/watch/claim', { method: 'POST', body: JSON.stringify({ code: 'GOOD-CODE' }) })
    expect(reply.status).toBe(200)
    expect(await reply.json()).toMatchObject({ ok: true, token: TOKEN, desktop: 'MacBook Pro' })
  })

  it('a wrong code is the claim\'s own refusal, never "sealed only"', async () => {
    const reply = await relayed('/api/watch/claim', { method: 'POST', body: JSON.stringify({ code: 'WRONG' }) })
    expect(reply.status).toBe(403)
    expect(await reply.json()).toEqual({ ok: false, reason: 'wrong' })
  })

  it('everything else in the clear stays refused: the claim\'s token, the owner\'s, a GET of the claim', async () => {
    for (const [route, init] of [
      ['/api/watch/cards', { headers: { authorization: `Bearer ${TOKEN}` } }],
      ['/api/watch/cards', { headers: { authorization: `Bearer ${OWNER}` } }],
      ['/api/watch/claim', {}],
      ['/api/watch/rekey', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${TOKEN}` } }]
    ] as const) {
      const reply = await relayed(route, init as RequestInit)
      expect(reply.status, route).toBe(403)
      expect(await reply.json(), route).toEqual({ error: SEALED_ONLY_ERROR })
    }
  })

  it('off the relay line nothing changes: the claim is answered as always', async () => {
    const reply = await fetch(`${origin}/api/watch/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'GOOD-CODE' }) })
    expect(reply.status).toBe(200)
  })
})
