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
    for (const path of [
      '/api/agents/t1/restore/undo',
      '/api/workspaces',
      '/api/workspaces/ws-1/service',
      '/api/nodes'
    ]) {
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
      // A CLASSIFIED route, because an unknown one is now a 403 (below): the
      // gate's job is to authorize the manifest, and the router's is to say
      // what exists. /api/say is served by mobile-server, past this module.
      new URL('/api/say', 'http://lan.local'),
      stubDeps()
    )
    // Gate passed; no route handler owned it in these bare deps, so the server
    // keeps dispatching.
    expect(handled).toBe(false)
  })

  it('gates read-only GETs too — deny-by-default replaced "GETs are open"', async () => {
    // The migration: /api/* used to be write-gated, so every read (board,
    // state, activity, transcripts) was open to anyone on the LAN. Header-less
    // clients now present the token as a stream ticket instead (v4 §4).
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

// ---------------------------------------------------------------------------
// V4 §4 — Probe's G4 blocker list, as unit cases. The live eval (16/29,
// scratchpad/v4-auth-eval.mjs) named four blockers; each `A##` below is the
// check id it maps to, so a red row over HTTP has a test that fails with it.
// ---------------------------------------------------------------------------

const WALL = 'wall-token-456'

/** Both credentials configured, as the running server always has them. */
function gatedDeps(): MobileApiDeps {
  return { pairingToken: TOKEN, wallToken: WALL } as unknown as MobileApiDeps
}

const at = (path: string): URL => new URL(path, 'http://lan.local')

async function call(
  method: string,
  path: string,
  token?: string
): Promise<{ status: number; body: unknown; handled: boolean }> {
  const { response, captured } = stubResponse()
  const handled = await handleMobileApi(
    stubRequest(method, token ? `Bearer ${token}` : undefined, method === 'GET' ? undefined : '{}'),
    response,
    at(path),
    gatedDeps()
  )
  return { status: captured.status, body: captured.body, handled }
}

describe('v4 §4 gate — deny-by-default over every /api/* route', () => {
  const GARBAGE = 'x'.repeat(TOKEN.length)

  it('A05/A06: an observe GET is 401 with no token and with a garbage token', async () => {
    // The blocker as Probe measured it: both of these answered 200.
    expect((await call('GET', '/api/workspaces')).status).toBe(401)
    expect((await call('GET', '/api/workspaces', GARBAGE)).status).toBe(401)
  })

  it('A07/A08: both known credentials may observe', async () => {
    // /api/state is `observe` and lives in mobile-server, so a cleared gate
    // shows up here as "not handled" rather than as a route touching deps.
    expect((await call('GET', '/api/state', WALL)).handled).toBe(false)
    expect((await call('GET', '/api/state', TOKEN)).handled).toBe(false)
  })

  it('A01–A04: /api/auth/status stays public, and answers what the caller holds', async () => {
    // The one route that must answer an unpaired device — it is how a phone
    // discovers it needs to pair rather than by failing at something else.
    for (const [token, scope] of [
      [undefined, 'none'],
      [GARBAGE, 'none'],
      [TOKEN, 'pairing'],
      [WALL, 'read-only']
    ] as const) {
      const response = await call('GET', '/api/auth/status', token)
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ scope })
    }
  })

  it('A11/A12: a write is 401 without a credential', async () => {
    expect((await call('POST', '/api/workspaces/ws-1/service')).status).toBe(401)
    expect((await call('POST', '/api/workspaces/ws-1/service', GARBAGE)).status).toBe(401)
  })

  it('A13: a WALL write is 403 — the 401→403 migration', async () => {
    // The semantics change, spec'd in §4 and already encoded in Piye's
    // gate.test.ts: the token is KNOWN, so "re-pair" is the wrong instruction.
    // 401 told a correct client to go fix a credential that was never broken.
    const response = await call('POST', '/api/workspaces/ws-1/service', WALL)
    expect(response.status).toBe(403)
    // The phrase the phone reads to tell a scope refusal from an unpaired
    // device (remote-api.ts raises it as a read-only AuthError).
    expect(response.body).toMatchObject({ error: expect.stringMatching(/read-only/i) })
  })

  it('A17: dispatch is out of the wall’s groups — 403, and not a 404 either', async () => {
    // Authorization outranks existence: this agent id does not exist, and the
    // caller must not be able to learn that.
    const response = await call('POST', '/api/agents/00000000-0000-4000-8000-000000000000/dispatch', WALL)
    expect(response.status).toBe(403)
  })

  it('A15/A16: authentication happens BEFORE resolution — 401, never 404', async () => {
    const missing = '/api/agents/00000000-0000-4000-8000-000000000000/dispatch'
    expect((await call('POST', missing)).status).toBe(401)
    expect((await call('POST', missing, GARBAGE)).status).toBe(401)
  })

  it('A18–A25: an unclassified route is 401 unauthenticated and 403 authenticated', async () => {
    // The ORDER blocker: an unknown /api/* path used to 404 before auth,
    // which answers "no such thing" to a caller we have not identified.
    for (const method of ['GET', 'POST']) {
      expect((await call(method, '/api/v4-unclassified')).status).toBe(401)
      expect((await call(method, '/api/v4-unclassified', GARBAGE)).status).toBe(401)
      expect((await call(method, '/api/v4-unclassified', WALL)).status).toBe(403)
      expect((await call(method, '/api/v4-unclassified', TOKEN)).status).toBe(403)
    }
  })

  it('a 403 body never says which route or workspace would have worked', async () => {
    const response = await call('GET', '/api/v4-unclassified', TOKEN)
    expect(JSON.stringify(response.body)).not.toContain('v4-unclassified')
  })

  it('leaves the static bootstrap ungated — a phone must be able to load the client', async () => {
    // handleMobileApi does not serve these, but it must not REFUSE them
    // either: gating the bundle leaves a phone with a blank page and no way
    // to pair. Non-/api paths fall through untouched.
    for (const path of ['/', '/index.html', '/assets/index-abc123.js']) {
      expect((await call('GET', path)).handled).toBe(false)
    }
  })

  it('a token in the query still authenticates — EventSource has no headers', async () => {
    const { response, captured } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('GET'),
      response,
      at(`/api/state?token=${TOKEN}`),
      gatedDeps()
    )
    expect(handled).toBe(false)
    expect(captured.status).toBe(0)
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
