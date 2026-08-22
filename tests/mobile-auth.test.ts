import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import type http from 'node:http'
import { pairingAuthorized } from '../src/main/mobile-http'
import { handleMobileApi, MobileApiDeps } from '../src/main/mobile-api'

// C1/C2: the mobile companion listens on 0.0.0.0, so every MUTATING route
// (restore/undo, terminal input, workspace edits) requires the pairing
// token, and responses no longer carry a wildcard ACAO header.

const TOKEN = 'pairing-token-123'

function stubRequest(method: string, authorization?: string, body?: string): http.IncomingMessage {
  // A real readable so routes past the gate can read the body.
  const request = Readable.from(body ? [body] : []) as http.IncomingMessage
  request.method = method
  request.headers = authorization ? { authorization } : {}
  return request
}

interface Captured {
  status: number
  headers: Record<string, string>
  body: unknown
}

function stubResponse(): { response: http.ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: undefined }
  const response = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status
      captured.headers = headers
      return this
    },
    end(raw?: string) {
      captured.body = raw ? JSON.parse(raw) : undefined
    }
  } as unknown as http.ServerResponse
  return { response, captured }
}

function stubDeps(): MobileApiDeps {
  // The auth gate runs before any dep is touched, so the shells stay empty.
  return {
    pairingToken: TOKEN
  } as unknown as MobileApiDeps
}

describe('pairingAuthorized', () => {
  const url = (raw: string) => new URL(raw, 'http://lan.local')

  it('accepts a matching bearer header', () => {
    expect(pairingAuthorized(stubRequest('POST', `Bearer ${TOKEN}`), url('/api/x'), TOKEN)).toBe(true)
  })

  it('accepts the token as a query param (header-less clients)', () => {
    expect(pairingAuthorized(stubRequest('POST'), url(`/api/x?token=${TOKEN}`), TOKEN)).toBe(true)
  })

  it('rejects a wrong token, a missing token, and a different-length token', () => {
    expect(pairingAuthorized(stubRequest('POST', 'Bearer nope'), url('/api/x'), TOKEN)).toBe(false)
    expect(pairingAuthorized(stubRequest('POST'), url('/api/x'), TOKEN)).toBe(false)
    expect(pairingAuthorized(stubRequest('POST', `Bearer ${TOKEN}x`), url('/api/x'), TOKEN)).toBe(false)
  })
})

describe('handleMobileApi mutating-route gate', () => {
  it('401s an unauthenticated POST to the restore endpoint (handled, never reaches the executor)', async () => {
    const { response, captured } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('POST'),
      response,
      new URL('/api/agents/t1/restore', 'http://lan.local'),
      stubDeps()
    )
    expect(handled).toBe(true)
    expect(captured.status).toBe(401)
    expect(captured.body).toMatchObject({ error: expect.stringMatching(/Unauthorized/i) })
  })

  it('401s restore/undo and workspace mutations without a token', async () => {
    for (const path of ['/api/agents/t1/restore/undo', '/api/workspaces', '/api/nodes']) {
      const { response, captured } = stubResponse()
      await handleMobileApi(stubRequest('POST'), response, new URL(path, 'http://lan.local'), stubDeps())
      expect(captured.status).toBe(401)
    }
  })

  it('lets an authorized POST past the gate (falls through to route matching)', async () => {
    const { response } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('POST', `Bearer ${TOKEN}`),
      response,
      new URL('/api/no-such-route', 'http://lan.local'),
      stubDeps()
    )
    // Gate passed; no route owned the path, so the server keeps dispatching.
    expect(handled).toBe(false)
  })

  it('401s an unauthenticated GET — a read is a credential too', async () => {
    // This test used to assert the OPPOSITE, on the reasoning that "EventSource
    // cannot set headers, and with the C2 wildcard gone only same-origin pages
    // can read them cross-site anyway". Both halves are true; neither defends
    // this listener. Same-origin policy protects a victim's BROWSER from a page
    // it did not ask for — it says nothing about a direct client, and curl has
    // no origin. On 0.0.0.0 that made the roster (every workspace slug), the
    // canvas, pane content, transcripts and the event log anonymous reads.
    const { response, captured } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('GET'),
      response,
      new URL('/api/workspaces', 'http://lan.local'),
      stubDeps()
    )
    expect(handled).toBe(true)
    expect(captured.status).toBe(401)
  })

  it('lets an authorized GET past the gate, header or query param', async () => {
    // Both spellings, because the header-less one is not a convenience: it is
    // the only thing EventSource can do, and gating reads without it would
    // have taken the live streams down with the hole.
    for (const [request, url] of [
      [stubRequest('GET', `Bearer ${TOKEN}`), '/api/no-such-route'],
      [stubRequest('GET'), `/api/no-such-route?token=${TOKEN}`]
    ] as const) {
      const { response } = stubResponse()
      const handled = await handleMobileApi(
        request,
        response,
        new URL(url, 'http://lan.local'),
        stubDeps()
      )
      // Gate passed; no route owned the path, so the server keeps dispatching.
      expect(handled).toBe(false)
    }
  })

  it('lets a READ-ONLY token read, but still refuses it a write', async () => {
    // The two scopes survive the change: the wall token was always meant to be
    // GET-only, and this is the first gate that actually exercises the read
    // half of it.
    const deps = { pairingToken: TOKEN, wallToken: 'wall-token-456' } as MobileApiDeps
    const read = stubResponse()
    expect(
      await handleMobileApi(
        stubRequest('GET'),
        read.response,
        new URL('/api/no-such-route?token=wall-token-456', 'http://lan.local'),
        deps
      )
    ).toBe(false)

    const write = stubResponse()
    expect(
      await handleMobileApi(
        stubRequest('POST'),
        write.response,
        new URL('/api/no-such-route?token=wall-token-456', 'http://lan.local'),
        deps
      )
    ).toBe(true)
    expect(write.captured.status).toBe(401)
  })

  it('leaves /api/auth/status open — it is how an unpaired device finds out', async () => {
    // The one deliberate exception, and the reason the gate is scoped rather
    // than blanket: a device with no token must be able to learn that, and
    // this route discloses only whether the caller's OWN token works.
    const { response, captured } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('GET'),
      response,
      new URL('/api/auth/status', 'http://lan.local'),
      stubDeps()
    )
    expect(handled).toBe(true)
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({ scope: 'none' })
  })

  it('does not gate NON-/api GETs — the pairing screen has to be able to load', async () => {
    // An unpaired phone is served the renderer around this delegation, and a
    // gate that 401s the bundle is a gate that removes the screen the owner
    // uses to pair. Scoping to /api/ is what keeps the fix from eating it.
    for (const path of ['/', '/index.html', '/assets/index-abc123.js']) {
      const { response } = stubResponse()
      expect(
        await handleMobileApi(
          stubRequest('GET'),
          response,
          new URL(path, 'http://lan.local'),
          stubDeps()
        )
      ).toBe(false)
    }
  })

  it('passes everything when no pairing token is configured (loopback embedders)', async () => {
    const deps = stubDeps()
    delete deps.pairingToken
    const { response } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('POST'),
      response,
      new URL('/api/no-such-route', 'http://lan.local'),
      deps
    )
    expect(handled).toBe(false)
  })
})

describe('C2: no wildcard CORS headers', () => {
  it('respondJson omits access-control-allow-origin', async () => {
    const { response, captured } = stubResponse()
    await handleMobileApi(
      stubRequest('POST'),
      response,
      new URL('/api/agents/t1/restore', 'http://lan.local'),
      stubDeps()
    )
    expect(captured.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('M11: route-level restore/undo dispatch (authorized)', () => {
  function executorDeps(): { deps: MobileApiDeps; calls: [string, number | null][] } {
    const calls: [string, number | null][] = []
    const deps = {
      ...stubDeps(),
      restoreCheckpoint: async (id: string, index: number) => {
        calls.push([id, index])
        return { ok: true, id, name: 'Agent', checkpointIndex: index }
      },
      undoRestore: async (id: string) => {
        calls.push([id, null])
        return { ok: true, id, name: 'Agent', checkpointIndex: 0, undone: true }
      }
    } as unknown as MobileApiDeps
    return { deps, calls }
  }

  it('POST /api/agents/:id/restore reaches the executor with the parsed checkpointIndex', async () => {
    const { deps, calls } = executorDeps()
    const { response, captured } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('POST', `Bearer ${TOKEN}`, JSON.stringify({ checkpointIndex: 2 })),
      response,
      new URL('/api/agents/t1/restore', 'http://lan.local'),
      deps
    )
    expect(handled).toBe(true)
    expect(captured.status).toBe(200)
    expect(calls).toEqual([['t1', 2]])
  })

  it('400s a non-positive-integer checkpointIndex BEFORE touching the executor', async () => {
    const { deps, calls } = executorDeps()
    const { response, captured } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('POST', `Bearer ${TOKEN}`, JSON.stringify({ checkpointIndex: 0 })),
      response,
      new URL('/api/agents/t1/restore', 'http://lan.local'),
      deps
    )
    expect(handled).toBe(true)
    expect(captured.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('POST /api/agents/:id/restore/undo reaches the undo executor', async () => {
    const { deps, calls } = executorDeps()
    const { response, captured } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('POST', `Bearer ${TOKEN}`, '{}'),
      response,
      new URL('/api/agents/t1/restore/undo', 'http://lan.local'),
      deps
    )
    expect(handled).toBe(true)
    expect(captured.status).toBe(200)
    expect(calls).toEqual([['t1', null]])
  })
})

// ---------------------------------------------------------------------------
// The regression that motivated the fix: handleMobileApi's gate is allowed to
// fail OPEN when no pairing token is configured (the loopback-embedder escape
// asserted above). index.ts never passed one, so the LAN listener silently
// selected that escape and every mutating route was unauthenticated.
//
// The server now injects its own minted token before delegating, so the escape
// cannot be reached by omission. These assert the wiring, not the gate — the
// gate itself is covered above.
// ---------------------------------------------------------------------------
describe('C1 wiring: the server cannot delegate without credentials', () => {
  it('mobile-server injects the resolved tokens into the deps it delegates', () => {
    const src = readFileSync('src/main/mobile-server.ts', 'utf8')
    const call = src.slice(src.indexOf('const authed = {'), src.indexOf('handleMobileApi(request'))
    expect(call).toContain('pairingToken: activePairingToken')
    expect(call).toContain('wallToken: activeWallToken')
    // the delegation must use the injected object, never the raw deps
    const delegate = src.slice(src.indexOf('handleMobileApi(request'))
    expect(delegate.slice(0, 120)).toContain('authed')
    expect(delegate.slice(0, 120)).not.toMatch(/,\s*deps as MobileApiDeps/)
  })

  it('startMobileServer always resolves a pairing token, even when none is supplied', () => {
    const src = readFileSync('src/main/mobile-server.ts', 'utf8')
    // The fallback is now the PERSISTED token rather than a per-run UUID, so a
    // phone paired once survives a restart. The guarantee under test is
    // unchanged: the server never delegates without a credential.
    expect(src).toMatch(/activePairingToken = deps\.pairingToken \?\? loadOrCreatePairingToken\(\)/)
  })

  it('index.ts supplies the PERSISTED token — the fallback alone is not enough', () => {
    // The bug this pins: mobile-server's `deps.pairingToken ?? persisted()`
    // fallback is never reached, because index.ts always passes a token. It
    // passed randomUUID(), so every restart still unpaired every device while
    // the fallback sat there looking correct. Asserting mobile-server's source
    // proved the fallback EXISTS, not that anything reaches it.
    const src = readFileSync('src/main/index.ts', 'utf8')
    expect(src).toMatch(/const pairingToken = loadOrCreatePairingToken\(\)/)
    expect(src).not.toMatch(/const pairingToken = randomUUID\(\)/)
  })

  it('rotation swaps the token the RUNNING server checks, not just the file', () => {
    // Writing the file alone leaves the process authorizing the revoked token
    // while rejecting the freshly-printed one — the exact inverse of intent.
    const src = readFileSync('src/main/mobile-server.ts', 'utf8')
    const fn = src.slice(src.indexOf('export function rotateActivePairingToken'))
    expect(fn.slice(0, 200)).toMatch(/activePairingToken = rotatePairingToken\(\)/)
  })
})

// ---------------------------------------------------------------------------
// /api/auth/status — the route that lets the phone find out it is unpaired
// BEFORE it tries to act. Without it the only signal was a 401 on a write that
// the renderer swallowed, so the UI simply went dead.
// ---------------------------------------------------------------------------
describe('/api/auth/status', () => {
  const statusUrl = new URL('/api/auth/status', 'http://lan.local')

  it('reports the pairing scope for a valid token', async () => {
    const { response, captured } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('GET', `Bearer ${TOKEN}`),
      response,
      statusUrl,
      stubDeps()
    )
    expect(handled).toBe(true)
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({ scope: 'pairing', required: true, canWrite: true })
  })

  it('reports scope "none" — with a 200, not a 401 — for an unpaired device', async () => {
    // A 401 here would be caught by the very error path this route exists to
    // replace; the phone needs a plain answer it can render.
    const { response, captured } = stubResponse()
    await handleMobileApi(stubRequest('GET'), response, statusUrl, stubDeps())
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({ scope: 'none', canWrite: false })
  })

  it('distinguishes a read-only token from a pairing token', async () => {
    const deps = { pairingToken: TOKEN, wallToken: 'wall-token-456' } as unknown as MobileApiDeps
    const { response, captured } = stubResponse()
    await handleMobileApi(stubRequest('GET', 'Bearer wall-token-456'), response, statusUrl, deps)
    expect(captured.body).toMatchObject({ scope: 'read-only', canWrite: false })
  })

  it('never echoes the token back', async () => {
    const { response, captured } = stubResponse()
    await handleMobileApi(stubRequest('GET', `Bearer ${TOKEN}`), response, statusUrl, stubDeps())
    expect(JSON.stringify(captured.body)).not.toContain(TOKEN)
  })

  it('accepts a candidate token as a query param so a paste can be verified', async () => {
    const { response, captured } = stubResponse()
    await handleMobileApi(
      stubRequest('GET'),
      response,
      new URL(`/api/auth/status?token=${TOKEN}`, 'http://lan.local'),
      stubDeps()
    )
    expect(captured.body).toMatchObject({ scope: 'pairing' })
  })
})

describe('the read gate reaches the routes mobile-server owns itself', () => {
  // /api/state, a terminal's pane content and a browser card's screenshot are
  // answered by mobile-server AFTER it delegates here — `if (await
  // handleMobileApi(...)) return`. So they are covered only if this function
  // CLAIMS the request (returns true) before its own route matching, rather
  // than falling through for someone else to handle.
  //
  // Asserted rather than reasoned about. "The gate runs first so everything
  // below it is covered" is exactly the shape of argument that left reads open
  // in the first place, and it is one refactor away from being false.
  const OWNED_BY_SERVER = [
    '/api/state',
    '/api/terminal/t1/output',
    '/api/browser/b1/thumb',
    '/api/browser/capabilities'
  ]

  it('401s each of them, and claims the request so nothing downstream runs', async () => {
    for (const path of OWNED_BY_SERVER) {
      const { response, captured } = stubResponse()
      const handled = await handleMobileApi(
        stubRequest('GET'),
        response,
        new URL(path, 'http://lan.local'),
        stubDeps()
      )
      expect(handled, path).toBe(true)
      expect(captured.status, path).toBe(401)
    }
  })

  it('serves them again once a token is presented', async () => {
    // The other half: a gate that refused these forever would be a fix that
    // broke the phone rather than one that secured it.
    for (const path of OWNED_BY_SERVER) {
      const { response } = stubResponse()
      const handled = await handleMobileApi(
        stubRequest('GET', `Bearer ${TOKEN}`),
        response,
        new URL(path, 'http://lan.local'),
        stubDeps()
      )
      // Not claimed by the gate — falls through to mobile-server's own routes.
      expect(handled, path).toBe(false)
    }
  })
})
