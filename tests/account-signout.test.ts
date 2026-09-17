// SIGN OUT ON THIS MAC (v3, D12): this device leaves the account.
//
// The rule under test is the ORDER: the password is proven at the registry,
// the device is removed there, and only then is account.json removed here.
// Every refusal — wrong password, last device, a dead socket — leaves the file
// exactly as it was. The second half mounts the REAL registry and walks a
// two-device account through it: the leaving Mac is gone from GET /v2/me and
// the other still opens the account.

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

const PASSWORD = 'correct horse battery staple'

interface Reply {
  status: number
  body?: unknown
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean()
})

const accountFile = (base: string): string => path.join(base, 'account.json')

describe('signOutThisMac against a scripted registry', () => {
  let server: Server
  let origin = ''
  let asked: { method: string; url: string }[] = []
  let script = new Map<string, Reply[]>()
  const answer = (route: string, ...replies: Reply[]): void => void script.set(route, replies)

  beforeEach(async () => {
    asked = []
    script = new Map()
    server = createServer((request, response) => {
      request.on('data', () => undefined)
      request.on('end', () => {
        const url = request.url ?? ''
        asked.push({ method: request.method ?? '', url })
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

  /** A Mac that is @drej, with a live session, pointed at the scripted registry. */
  const signedInMac = (): { base: string; it: Accounts; deviceId: string; changes: number[] } => {
    const { base, clean } = tempBase()
    cleanups.push(clean)
    const file = fakeAccount({ registry: origin })
    writeAccount(file, base)
    const changes: number[] = []
    const it = new Accounts({ base, origin, onChange: () => changes.push(Date.now()) })
    return { base, it, deviceId: file.deviceId, changes }
  }

  const LIVE: Reply = { status: 201, body: { token: 'fresh', exp: Date.now() + 3_600_000 } }

  it('proves the password, removes THIS device at the registry, then removes the file', async () => {
    const { base, it, deviceId, changes } = signedInMac()
    answer('POST /v2/sessions', LIVE)
    answer(`DELETE /v2/me/devices/${encodeURIComponent(deviceId)}`, { status: 204 })

    expect(await it.signOutThisMac(PASSWORD)).toEqual({ ok: true, value: undefined })

    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual([
      'POST /v2/sessions',
      `DELETE /v2/me/devices/${encodeURIComponent(deviceId)}`,
    ])
    expect(existsSync(accountFile(base))).toBe(false)
    expect(it.account()).toBeNull()
    expect(loadAccount(base)).toBeNull()
    // Told once, after the file is gone — the surface redraws an empty avatar.
    expect(changes.length).toBeGreaterThanOrEqual(1)
  })

  it('refuses the last device with the registry’s reason, and keeps the file', async () => {
    const { base, it, deviceId } = signedInMac()
    answer('POST /v2/sessions', LIVE)
    answer(`DELETE /v2/me/devices/${encodeURIComponent(deviceId)}`, {
      status: 409,
      body: { error: 'last_device' },
    })
    expect(await it.signOutThisMac(PASSWORD)).toMatchObject({ ok: false, reason: 'last_device' })
    expect(existsSync(accountFile(base))).toBe(true)
    expect(it.account()?.username).toBe('drej')
  })

  it('a wrong password never reaches the DELETE', async () => {
    const { base, it } = signedInMac()
    answer('POST /v2/sessions', { status: 401, body: { error: 'bad_credentials', message: 'Not it.' } })
    const out = await it.signOutThisMac('not the one')
    expect(out.ok).toBe(false)
    expect(asked.map((a) => a.method)).toEqual(['POST'])
    expect(existsSync(accountFile(base))).toBe(true)
  })

  it('a ladder is a refusal here, not a climb', async () => {
    const { base, it } = signedInMac()
    answer('POST /v2/sessions', {
      status: 401,
      body: { error: 'second_factor', pending: '11111111-2222-4333-8444-555555555555', next: ['totp'], expiresAt: Date.now() + 600_000 },
    })
    expect(await it.signOutThisMac(PASSWORD)).toMatchObject({ ok: false, reason: 'bad_credentials' })
    expect(asked).toHaveLength(1)
    expect(existsSync(accountFile(base))).toBe(true)
  })

  it('a registry that does not answer is offline, and the file stays', async () => {
    const { base, clean } = tempBase()
    cleanups.push(clean)
    writeAccount(fakeAccount({ registry: 'http://127.0.0.1:1' }), base)
    const dead = new Accounts({ base, origin: 'http://127.0.0.1:1' })
    expect(await dead.signOutThisMac(PASSWORD)).toEqual({ ok: false, reason: 'offline' })
    expect(existsSync(accountFile(base))).toBe(true)
  })

  it('a Mac with no account has nothing to leave', async () => {
    const { base, clean } = tempBase()
    cleanups.push(clean)
    expect(await new Accounts({ base, origin }).signOutThisMac(PASSWORD)).toEqual({ ok: false, reason: 'no_account' })
    expect(asked).toHaveLength(0)
  })
})

describe('signOutThisMac against the real registry', () => {
  let server: Server
  let origin = ''
  let dir = ''

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'v3-signout-registry-'))
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

  const mac = (name: string): { base: string; it: Accounts } => {
    const { base, clean } = tempBase()
    cleanups.push(clean)
    return { base, it: new Accounts({ base, origin, deviceName: name }) }
  }

  it('a two-device account: the leaving Mac is gone from /v2/me, the other still opens it', async () => {
    const first = mac('MacBook Pro · drej-mbp')
    expect(await first.it.claim({ username: 'drej', password: PASSWORD })).toMatchObject({ ok: true })
    const codes = await first.it.recoveryCodes()
    if (!codes.ok) throw new Error('no codes')

    const second = mac('Mac Studio · studio')
    const step = await second.it.signIn({ username: 'drej', password: PASSWORD })
    if (step.ok || step.reason !== 'second_factor') throw new Error(`expected the ladder, got ${JSON.stringify(step)}`)
    expect(await second.it.resumeWithCode(step.step.pending, 'recovery', codes.value[0])).toMatchObject({ ok: true })

    // The second Mac signs out. Its file goes; the registry lists one device.
    expect(await second.it.signOutThisMac(PASSWORD)).toEqual({ ok: true, value: undefined })
    expect(existsSync(accountFile(second.base))).toBe(false)
    expect(second.it.account()).toBeNull()

    const me = await first.it.call<{ devices: { name: string }[] }>('/v2/me', { method: 'GET' })
    expect(me.ok).toBe(true)
    if (!me.ok) return
    expect(me.value.devices.map((d) => d.name)).toEqual(['MacBook Pro · drej-mbp'])
  }, 30_000)

  it('a one-device account is refused with last_device, and nothing changes', async () => {
    const only = mac('MacBook Pro · drej-mbp')
    expect(await only.it.claim({ username: 'drej', password: PASSWORD })).toMatchObject({ ok: true })
    expect(await only.it.signOutThisMac(PASSWORD)).toMatchObject({ ok: false, reason: 'last_device' })
    expect(existsSync(accountFile(only.base))).toBe(true)
    expect(only.it.sessionLive()).toBe(true)
    const me = await only.it.call<{ devices: unknown[] }>('/v2/me', { method: 'GET' })
    expect(me.ok && me.value.devices.length).toBe(1)
  }, 30_000)

  it('the wrong password is refused at the registry and the device stays', async () => {
    const only = mac('MacBook Pro · drej-mbp')
    await only.it.claim({ username: 'drej', password: PASSWORD })
    const out = await only.it.signOutThisMac('not the one')
    expect(out.ok).toBe(false)
    expect(existsSync(accountFile(only.base))).toBe(true)
  }, 30_000)
})
