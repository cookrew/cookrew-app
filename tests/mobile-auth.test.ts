import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
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

  it('does not gate read-only GETs (EventSource cannot set headers)', async () => {
    const { response } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('GET'),
      response,
      new URL('/api/no-such-route', 'http://lan.local'),
      stubDeps()
    )
    expect(handled).toBe(false)
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
