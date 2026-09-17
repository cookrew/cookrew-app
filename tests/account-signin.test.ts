// THE SECOND MAC (v3, D9 · D10): sign in with the password to an account
// this Mac has never held.
//
// Two halves. The first stands a scripted http server in for cookrew.dev so
// every answer the wire can give is exercised — 201, a wrong password, the
// ladder, a dead socket — and the one rule that matters most is asserted on
// every path: THE FILE IS WRITTEN ONLY ON 201. The second mounts the REAL
// registry (registry/src, in-process, over a real socket) and walks two
// account bases through it: the first claims the name, the second signs in,
// climbs the ladder the registry actually hands a new device, and shows up
// beside the first in GET /v2/me. Nothing here prints a token or a password.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Accounts, loadAccount, writeAccount } from '../src/main/account-v2'
import { createV2, handleV2Route } from '../registry/src/v2-routes'
import type { V2Context } from '../registry/src/v2-http'
import { fakeAccount, tempBase } from './support/idv2'

const PASSWORD = 'an older, shorter one'
const PENDING = '11111111-2222-4333-8444-555555555555'

interface Reply {
  status: number
  body?: unknown
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean()
})

/** A Mac with nothing on it: no account.json at all. */
function emptyMac(): string {
  const { base, clean } = tempBase()
  cleanups.push(clean)
  return base
}

const accountFile = (base: string): string => path.join(base, 'account.json')

describe('signIn against a scripted registry', () => {
  let server: Server
  let origin = ''
  let asked: { method: string; url: string; body: string }[] = []
  let script = new Map<string, Reply[]>()
  const answer = (route: string, ...replies: Reply[]): void => void script.set(route, replies)

  beforeEach(async () => {
    asked = []
    script = new Map()
    server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
      request.on('end', () => {
        const url = request.url ?? ''
        asked.push({ method: request.method ?? '', url, body: raw })
        const queued = script.get(`${request.method} ${url}`) ?? []
        const reply = queued.length > 1 ? (queued.shift() as Reply) : queued[0]
        if (!reply) {
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end('{"error":"not_found"}')
          return
        }
        response.writeHead(reply.status, { 'content-type': 'application/json' })
        response.end(reply.body === undefined ? '' : JSON.stringify(reply.body))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  })

  const app = (base: string): Accounts => new Accounts({ base, origin, deviceName: 'Second Mac' })

  const LIVE = { status: 201, body: { token: 'fresh-token', exp: Date.now() + 3_600_000 } }
  const SECOND_FACTOR = {
    status: 401,
    body: {
      error: 'second_factor',
      message: 'One more step. Prove it is you.',
      next: ['approve', 'recovery'],
      pending: PENDING,
      expiresAt: Date.now() + 600_000,
    },
  }

  it('writes the file on 201, and only then — a fresh key, the name typed, the verifier set', async () => {
    answer('POST /v2/sessions', LIVE)
    const base = emptyMac()
    const it = app(base)
    expect(existsSync(accountFile(base))).toBe(false)
    const out = await it.signIn({ username: ' @drej ', password: PASSWORD })
    expect(out).toMatchObject({ ok: true })
    const file = loadAccount(base)
    expect(file?.username).toBe('drej')
    expect(file?.name).toBe('Second Mac')
    expect(file?.kind).toBe('desktop')
    expect(file?.session?.token).toBeDefined()
    expect(it.sessionLive()).toBe(true)
    // The verifier is the password's: the same password unlocks the app offline.
    expect(it.verifyUnlock(PASSWORD)).toBe(true)
    expect(it.verifyUnlock('something else')).toBe(false)
    // One request, to the session route, carrying a device with a key.
    expect(asked).toHaveLength(1)
    expect(asked[0].url).toBe('/v2/sessions')
    const sent = JSON.parse(asked[0].body) as { username: string; device: { id: string; kind: string; jwk: unknown } }
    expect(sent.username).toBe('drej')
    expect(sent.device.kind).toBe('desktop')
    expect(sent.device.jwk).toBeDefined()
    expect(sent.device.id).toBe(file?.deviceId)
  })

  it('takes the registry\'s names over its own when the answer carries them', async () => {
    answer('POST /v2/sessions', {
      status: 201,
      body: { token: 'fresh-token', exp: Date.now() + 3_600_000, username: 'drej', deviceId: 'dev-as-filed' },
    })
    const base = emptyMac()
    await app(base).signIn({ username: 'drej', password: PASSWORD, name: 'Studio' })
    expect(loadAccount(base)).toMatchObject({ deviceId: 'dev-as-filed', name: 'Studio' })
  })

  it('a wrong password is the prompt again, with the registry\'s sentence, and no file', async () => {
    answer('POST /v2/sessions', {
      status: 401,
      body: { error: 'bad_credentials', message: 'That is not the password for @drej.' },
    })
    const base = emptyMac()
    const out = await app(base).signIn({ username: 'drej', password: 'not-it' })
    expect(out).toEqual({ ok: false, reason: 'session-expired', message: 'That is not the password for @drej.' })
    expect(existsSync(accountFile(base))).toBe(false)
  })

  it('a new device answers the ladder: the step comes back with its pending, and the file waits', async () => {
    answer('POST /v2/sessions', SECOND_FACTOR)
    const base = emptyMac()
    const out = await app(base).signIn({ username: 'drej', password: PASSWORD })
    expect(out.ok).toBe(false)
    if (out.ok || out.reason !== 'second_factor') throw new Error('expected a step')
    expect(out.step.pending).toBe(PENDING)
    expect(out.step.next).toEqual(['approve', 'recovery'])
    expect(out.message).toBe('One more step. Prove it is you.')
    expect(existsSync(accountFile(base))).toBe(false)
  })

  it('the rung that lands writes the file with the key minted at the password step — the resume ladder, unchanged', async () => {
    answer('POST /v2/sessions', SECOND_FACTOR)
    const base = emptyMac()
    const it = app(base)
    await it.signIn({ username: 'drej', password: PASSWORD })
    const minted = JSON.parse(asked[0].body) as { device: { id: string } }
    // The password was remembered under the pending: the typed rung carries
    // only the code, exactly as a resume's would.
    answer(`POST /v2/sessions/${PENDING}/recovery`, LIVE)
    expect(await it.resumeWithCode(PENDING, 'recovery', 'AAAA-BBBB')).toMatchObject({ ok: true })
    expect(JSON.parse(asked[asked.length - 1].body)).toEqual({ code: 'AAAA-BBBB' })
    const file = loadAccount(base)
    expect(file?.username).toBe('drej')
    expect(file?.deviceId).toBe(minted.device.id)
    expect(it.sessionLive()).toBe(true)
    expect(it.verifyUnlock(PASSWORD)).toBe(true)
  })

  it('the approve rung lands the same way, through the wait', async () => {
    answer('POST /v2/sessions', SECOND_FACTOR)
    const base = emptyMac()
    const it = app(base)
    await it.signIn({ username: 'drej', password: PASSWORD })
    // The poll: 202 is "still waiting", then the nod lands the session.
    answer(`GET /v2/sessions/${PENDING}`, { status: 202, body: { pending: PENDING } }, LIVE)
    const landed = await it.resumeWait(PENDING, { everyMs: 5, forMs: 2_000 })
    expect(landed).toMatchObject({ ok: true })
    expect(loadAccount(base)?.username).toBe('drej')
  })

  it('a ladder that goes cold leaves no file behind', async () => {
    answer('POST /v2/sessions', SECOND_FACTOR)
    const base = emptyMac()
    const it = app(base)
    await it.signIn({ username: 'drej', password: PASSWORD })
    answer(`POST /v2/sessions/${PENDING}/recovery`, {
      status: 410,
      body: { error: 'expired', message: 'That sign-in timed out. Start again.' },
    })
    expect(await it.resumeWithCode(PENDING, 'recovery', 'AAAA-BBBB')).toMatchObject({ ok: false, reason: 'expired' })
    expect(existsSync(accountFile(base))).toBe(false)
  })

  it('a registry that does not answer is offline, and nothing is written', async () => {
    const base = emptyMac()
    const dead = new Accounts({ base, origin: 'http://127.0.0.1:1' })
    expect(await dead.signIn({ username: 'drej', password: PASSWORD })).toEqual({ ok: false, reason: 'offline' })
    expect(existsSync(accountFile(base))).toBe(false)
  })

  it('refuses locally only for shape: an empty or malformed name never reaches the wire', async () => {
    answer('POST /v2/sessions', LIVE)
    const it = app(emptyMac())
    // Case is not folded, as claim does not fold it: "Drej" is refused, not
    // quietly signed in as somebody else's lowercase name. What the local
    // shape check lets through (a leading dash, say) is the registry's to
    // refuse, and it does.
    for (const username of ['', '   ', 'dr ej', 'Drej', 'acct-1234']) {
      expect(await it.signIn({ username, password: PASSWORD }), username).toEqual({ ok: false, reason: 'bad_username' })
    }
    expect(asked).toHaveLength(0)
  })

  it('does NOT gate the password length — an old account may have a short one', async () => {
    answer('POST /v2/sessions', LIVE)
    const it = app(emptyMac())
    expect(await it.signIn({ username: 'drej', password: 'short' })).toMatchObject({ ok: true })
    expect(asked).toHaveLength(1)
  })

  it('refuses on a Mac that is already somebody — that is a resume, not a sign-in', async () => {
    const { base, clean } = tempBase()
    cleanups.push(clean)
    writeAccount(fakeAccount({ registry: origin }), base)
    const out = await app(base).signIn({ username: 'anvz', password: PASSWORD })
    expect(out).toMatchObject({ ok: false, reason: 'taken' })
    expect(asked).toHaveLength(0)
  })

  it('is rate-limited as itself', async () => {
    answer('POST /v2/sessions', { status: 429, body: { error: 'rate_limited' } })
    expect(await app(emptyMac()).signIn({ username: 'drej', password: PASSWORD })).toEqual({
      ok: false,
      reason: 'rate_limited',
    })
  })
})

describe('signIn against the real registry: a second Mac joins the account', () => {
  let server: Server
  let origin = ''
  let dir = ''

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'v3-signin-registry-'))
    const v2 = createV2(dir)
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://registry.test')
      const ctx: V2Context = {
        method: request.method ?? 'GET',
        parts: url.pathname.split('/').filter((part) => part.length > 0),
        request,
        response,
        v2,
        secure: false,
        decode: (value) => {
          try {
            return decodeURIComponent(value)
          } catch {
            return null
          }
        },
      }
      if (!handleV2Route(ctx)) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{"error":"not_found"}')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    rmSync(dir, { recursive: true, force: true })
  })

  const CLAIM_PASSWORD = 'correct horse battery staple'

  it('signs in as an existing account and appears in GET /v2/me devices', async () => {
    // The first Mac claims the name and mints the rescue codes.
    const firstBase = emptyMac()
    const first = new Accounts({ base: firstBase, origin, deviceName: 'First Mac' })
    expect(await first.claim({ username: 'drej', password: CLAIM_PASSWORD })).toMatchObject({ ok: true })
    const codes = await first.recoveryCodes()
    expect(codes.ok).toBe(true)
    if (!codes.ok) return

    // The second Mac, blank, types the name and the password. The registry
    // hands a new device the ladder (D9): the first Mac's approval, or a code.
    const secondBase = emptyMac()
    const second = new Accounts({ base: secondBase, origin, deviceName: 'Second Mac' })
    const step = await second.signIn({ username: 'drej', password: CLAIM_PASSWORD })
    expect(step.ok).toBe(false)
    if (step.ok || step.reason !== 'second_factor') throw new Error(`expected the ladder, got ${JSON.stringify(step)}`)
    expect(step.step.next).toContain('approve')
    expect(step.step.next).toContain('recovery')
    expect(existsSync(accountFile(secondBase))).toBe(false)

    // A rescue code climbs it; the file lands with the key minted at the step.
    const landed = await second.resumeWithCode(step.step.pending, 'recovery', codes.value[0])
    expect(landed).toMatchObject({ ok: true })
    const file = loadAccount(secondBase)
    expect(file?.username).toBe('drej')
    expect(file?.name).toBe('Second Mac')
    expect(second.sessionLive()).toBe(true)
    expect(second.verifyUnlock(CLAIM_PASSWORD)).toBe(true)

    // Both Macs are on the account, and each sees the other.
    const me = await second.call<{ devices: { id: string; name: string }[] }>('/v2/me', { method: 'GET' })
    expect(me.ok).toBe(true)
    if (!me.ok) return
    expect(me.value.devices.map((d) => d.name).sort()).toEqual(['First Mac', 'Second Mac'])
    expect(me.value.devices.some((d) => d.id === file?.deviceId)).toBe(true)
    const fromFirst = await first.call<{ devices: { id: string }[] }>('/v2/me', { method: 'GET' })
    expect(fromFirst.ok && fromFirst.value.devices.length).toBe(2)
    // The registry hashes with scrypt at its real cost: a claim and two
    // sign-ins are seconds, not milliseconds, and this is the point.
  }, 30_000)

  it('refuses the wrong password with the registry\'s own sentence, and writes nothing', async () => {
    const first = new Accounts({ base: emptyMac(), origin })
    await first.claim({ username: 'drej', password: CLAIM_PASSWORD })
    const secondBase = emptyMac()
    const out = await new Accounts({ base: secondBase, origin }).signIn({ username: 'drej', password: 'not the one' })
    expect(out).toMatchObject({ ok: false, reason: 'session-expired' })
    if (out.ok) return
    expect(typeof out.message).toBe('string')
    expect(existsSync(accountFile(secondBase))).toBe(false)
  }, 30_000)
})
