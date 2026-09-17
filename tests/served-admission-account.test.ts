import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  admitWithAccount,
  mintCallToken,
  type AccountForDoors
} from '../src/main/served-admission'

/**
 * THE INSTALL WALK, from the caller's Mac (identity v3, G1).
 *
 * cookrew.dev is scripted — one answer per test, the way the registry
 * actually answers POST /v2/teams/@o/t/call-token — and the DOOR is a real
 * listener, because the door's half (assert with {v2Token}, then open the
 * line) is the half a scripted fetch would let drift. What is pinned: the
 * account is the only credential offered, the seat rung comes back as the
 * no_seat phase and never as a key attempt, and no account means `identify`
 * rather than an error.
 */

const TEAM = '@mira/research-crew'

/** A registry that answers one way. */
function registry(
  status: number,
  body: unknown,
  username: string | null = 'jkim'
): AccountForDoors & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    account: () => (username === null ? null : { username }),
    authedResponse: async (pathname, init) => {
      asked.push(`${init?.method ?? 'GET'} ${pathname}`)
      if (username === null) return { ok: false, reason: 'no_account' }
      return {
        ok: true,
        response: new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' }
        })
      }
    }
  }
}

describe('mintCallToken — what cookrew.dev said', () => {
  it('asks the seat route with this Mac’s session and reads the seat that admits us', async () => {
    const reg = registry(201, { token: 't.v2', account: 'jkim', seat: 'seat-7', aud: TEAM })
    expect(await mintCallToken(reg, TEAM)).toEqual({
      kind: 'token',
      token: 't.v2',
      account: 'jkim',
      seat: 'seat-7'
    })
    expect(reg.asked).toEqual(['POST /v2/teams/%40mira/research-crew/call-token'])
  })

  it('no account on this Mac is identify, not an error', async () => {
    expect(await mintCallToken(registry(0, null, null), TEAM)).toEqual({ kind: 'identify' })
  })

  it('a session the registry refuses is identify too — the next step is the sheet', async () => {
    expect(await mintCallToken(registry(401, { error: 'unauthenticated' }), TEAM)).toEqual({
      kind: 'identify'
    })
  })

  it('403 no_seat is the seat rung, by name', async () => {
    expect(await mintCallToken(registry(403, { error: 'no_seat', message: '…' }), TEAM)).toEqual({
      kind: 'no_seat'
    })
  })

  it('anything else is a refusal carrying its status', async () => {
    expect(await mintCallToken(registry(404, { error: 'not_found' }), TEAM)).toEqual({
      kind: 'refused',
      status: 404
    })
  })
})

describe('admitWithAccount — the account at a listed door', () => {
  let server: Server
  let origin = ''
  /** Every body the door was handed at /api/call/assert. */
  const asserted: unknown[] = []
  /** What the door answers the line with, per test. */
  let line: { status: number; body?: unknown } = { status: 200 }
  let assertAnswer: { status: number; body: unknown } = {
    status: 200,
    body: { ok: true, token: 'door-bearer', account: 'jkim', seat: 'seat-7' }
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => void (raw += chunk))
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/research-crew/api/call/assert') {
          asserted.push(JSON.parse(raw))
          res.writeHead(assertAnswer.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(assertAnswer.body))
          return
        }
        if (req.method === 'GET' && req.url === '/research-crew/line') {
          const bearer = req.headers.authorization === 'Bearer door-bearer'
          if (!bearer) {
            res.writeHead(401, { 'content-type': 'application/json' })
            res.end('{}')
            return
          }
          res.writeHead(line.status, { 'content-type': 'application/json' })
          res.end(line.body === undefined ? '' : JSON.stringify(line.body))
          return
        }
        // The key ceremony's routes: reached only by a caller that offered a
        // key, which the install walk must never do.
        res.writeHead(500)
        res.end('the install walk knocked on a key route')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  const target = (): { origin: string; slug: string } => ({ origin, slug: 'research-crew' })

  it('presents {v2Token} alone, and a seated account opens the same session with no second payment', async () => {
    asserted.length = 0
    line = { status: 200 }
    const out = await admitWithAccount(
      target(),
      TEAM,
      registry(201, { token: 't.v2', account: 'jkim', seat: 'seat-7' })
    )
    expect(asserted).toEqual([{ v2Token: 't.v2' }])
    expect(out).toEqual({
      phase: { kind: 'open' },
      token: 'door-bearer',
      account: 'jkim',
      seat: 'seat-7'
    })
  })

  it('a paid door with no open session quotes the 402 — the seat is the entitlement, the session is bought once', async () => {
    line = { status: 402, body: { terms: { x402Version: 1, accepts: [] } } }
    const out = await admitWithAccount(
      target(),
      TEAM,
      registry(201, { token: 't.v2', account: 'jkim', seat: 'seat-7' })
    )
    expect(out.phase).toEqual({ kind: 'pay', rails: [] })
    expect(out.token).toBe('door-bearer')
  })

  it('no account on this Mac stops at identify and never reaches the door', async () => {
    asserted.length = 0
    const out = await admitWithAccount(target(), TEAM, registry(0, null, null))
    expect(out).toEqual({ phase: { kind: 'identify' }, token: null, account: null, seat: null })
    expect(asserted).toEqual([])
  })

  it('the registry’s no_seat is the seat phase, with who this Mac is', async () => {
    asserted.length = 0
    const out = await admitWithAccount(target(), TEAM, registry(403, { error: 'no_seat' }))
    expect(out.phase).toEqual({ kind: 'denied', reason: 'no_seat', retryable: false })
    expect(out.account).toBe('jkim')
    expect(out.token).toBeNull()
    expect(asserted).toEqual([])
  })

  it('the door’s own seat rung is read the same way', async () => {
    assertAnswer = { status: 403, body: { reason: 'no_seat', error: '…' } }
    const out = await admitWithAccount(
      target(),
      TEAM,
      registry(201, { token: 't.v2', account: 'jkim', seat: null })
    )
    expect(out.phase).toEqual({ kind: 'denied', reason: 'no_seat', retryable: false })
    expect(out.token).toBeNull()
  })

  it('a door that cannot read account tokens is an error with its status, not a key attempt', async () => {
    assertAnswer = { status: 401, body: {} }
    const out = await admitWithAccount(
      target(),
      TEAM,
      registry(201, { token: 't.v2', account: 'jkim', seat: 'seat-7' })
    )
    expect(out.phase).toEqual({ kind: 'error', status: 401 })
    expect(out.token).toBeNull()
  })
})
