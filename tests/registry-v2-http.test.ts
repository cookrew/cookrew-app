import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'

/**
 * IDENTITY v2 OVER HTTP — every route, over the real router.
 *
 * The store's rules are proved next door; this proves the SERVER: the codes,
 * the sentences a person reads, the cookie the browser is handed, the limiter,
 * and the one place v1 and v2 have to agree — `accountOf`, which decides who
 * is reading a page and must now answer for a v2 session too.
 */

const PASSWORD = 'correct horse battery staple'

const device = (kind: 'desktop' | 'phone' | 'browser' = 'desktop', name = 'This Mac') => ({
  id: randomUUID(),
  kind,
  name,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

interface Up {
  origin: string
  close: () => Promise<void>
  dir: string
}

/** A registry with v2 mounted. `limits` left out means the contract's own. */
async function up(limits?: {
  accountsPerMinute: number
  sessionsPerMinute: number
  lookupsPerMinute?: number
}): Promise<Up> {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-http-'))
  const v2 = createV2(dir, limits === undefined ? {} : { limits })
  const doors = new DoorStore(dir, { allowPrivate: true })
  doors.register('somebody', {
    handle: 'somebody',
    name: 'alpha',
    title: 'ALPHA',
    door: 'Pilot',
    agents: 1,
    address: 'https://cookrew.dev/@somebody/alpha',
    transport: 'relay',
    access: 'account',
    rails: [],
    sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab',
    summary: 'A team.',
    tags: ['dev'],
    harnesses: ['Claude Code']
  })
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors,
    stars: new StarStore(dir),
    v2
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    dir,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      })
  }
}

let site: Up

beforeAll(async () => {
  site = await up({ accountsPerMinute: 1000, sessionsPerMinute: 1000 })
})
afterAll(async () => {
  await site.close()
})

const callOn = (
  at: Up,
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Response> =>
  fetch(`${at.origin}${p}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  })
const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  callOn(site, method, p, body, headers)
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

interface Claimed {
  username: string
  deviceId: string
  token: string
}

let minted = 0
async function claim(kind: 'desktop' | 'phone' | 'browser' = 'desktop'): Promise<Claimed> {
  const username = `owner${++minted}`
  const res = await call('POST', '/v2/accounts', { username, password: PASSWORD, device: device(kind) })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { deviceId: string; session: { token: string } }
  return { username, deviceId: body.deviceId, token: body.session.token }
}

/**
 * PHASE 4 CHANGED WHAT A PASSWORD BUYS on a device the account has never
 * seen: one more step, not a session. These tests are about what happens
 * AFTER a second device is attached, so they climb the shortest rung — the
 * account's own first device approves — and carry on. The ladder itself is
 * proved in registry-v2-ladder-http.test.ts.
 */
async function joinWithApproval(owner: Claimed, joining: ReturnType<typeof device>): Promise<Response> {
  const first = await call('POST', '/v2/sessions', {
    username: owner.username,
    password: PASSWORD,
    device: joining
  })
  if (first.status !== 401) return first
  const { pending } = (await first.json()) as { pending: string }
  const asked = await call('POST', `/v2/sessions/${pending}/approve`)
  const { approval } = (await asked.json()) as { approval: string }
  expect(
    (await call('POST', `/v2/me/approvals/${approval}`, { decision: 'approve' }, bearer(owner.token))).status
  ).toBe(204)
  return call('GET', `/v2/sessions/${pending}`)
}

describe('POST /v2/accounts — claiming a name', () => {
  it('mints the account, the first device and a session, and sets an HttpOnly cookie', async () => {
    const d = device()
    const res = await call('POST', '/v2/accounts', { username: 'drej', password: PASSWORD, device: d })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { username: string; deviceId: string; session: { token: string; exp: number } }
    expect(body.username).toBe('drej')
    expect(body.deviceId).toBe(d.id)
    expect(body.session.exp).toBeGreaterThan(Date.now())

    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/^__Host-cr_session=/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('refuses a name someone holds, in a sentence', async () => {
    const res = await call('POST', '/v2/accounts', { username: 'drej', password: PASSWORD, device: device() })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('taken')
    expect(body.message).toBe('@drej is someone else’s. Try another.')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('refuses a bad name, a weak password and a device that will not describe itself', async () => {
    const bad = [
      [{ username: 'Drej', password: PASSWORD, device: device() }, 'bad_username'],
      [{ username: 'acct-1234', password: PASSWORD, device: device() }, 'bad_username'],
      [{ username: 'shorty', password: 'too short', device: device() }, 'weak_password'],
      [{ username: 'shorty', password: PASSWORD, device: { ...device(), id: 'not-a-uuid' } }, 'bad_device'],
      [{ username: 'shorty', password: PASSWORD, device: { ...device(), jwk: { kty: 'RSA' } } }, 'bad_device']
    ] as const
    for (const [body, reason] of bad) {
      const res = await call('POST', '/v2/accounts', body)
      expect(res.status, reason).toBe(400)
      const out = (await res.json()) as { error: string; message: string }
      expect(out.error).toBe(reason)
      expect(out.message.length).toBeGreaterThan(12)
      expect(out.message).toMatch(/[.!]$/)
    }
  })

  it('refuses a body that is not an object at all', async () => {
    const res = await call('POST', '/v2/accounts', 'hello')
    expect(res.status).toBe(400)
  })
})

describe('HEAD|GET /v2/accounts/:username — is this name free', () => {
  it('answers 200 for taken and 404 for free, with no body either way', async () => {
    expect((await call('HEAD', '/v2/accounts/drej')).status).toBe(200)
    expect((await call('HEAD', '/v2/accounts/nobody-at-all')).status).toBe(404)
    expect((await call('HEAD', '/v2/accounts/NOT-A-NAME')).status).toBe(404)
  })

  it('shows a public profile with no devices in it', async () => {
    const res = await call('GET', '/v2/accounts/drej')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['displayName', 'username'])
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect((await call('GET', '/v2/accounts/nobody-at-all')).status).toBe(404)
  })
})

describe('POST /v2/sessions — signing in', () => {
  it('attaches a device the account approved, and lets it back in on the password alone', async () => {
    const owner = await claim()
    const phone = device('phone', 'iPhone')
    const res = await joinWithApproval(owner, phone)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { token: string; exp: number; deviceId: string }
    expect(body.deviceId).toBe(phone.id)
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')

    // A device the account already knows needs no second step, and is the
    // SAME device rather than a twin on the profile.
    const again = await call('POST', '/v2/sessions', { username: owner.username, password: PASSWORD, device: phone })
    expect(again.status).toBe(201)
    expect(((await again.json()) as { deviceId: string }).deviceId).toBe(phone.id)
    const me = (await (await call('GET', '/v2/me', undefined, bearer(body.token))).json()) as {
      devices: { id: string }[]
    }
    expect(me.devices.filter((d) => d.id === phone.id)).toHaveLength(1)
  })

  it('says exactly the same thing for an unknown name and a wrong password', async () => {
    const wrong = await call('POST', '/v2/sessions', { username: 'drej', password: 'nope nope nope', device: device('browser') })
    const nobody = await call('POST', '/v2/sessions', { username: 'ghost', password: PASSWORD, device: device('browser') })
    expect(wrong.status).toBe(401)
    expect(nobody.status).toBe(401)
    const a = (await wrong.json()) as { error: string; message: string }
    const b = (await nobody.json()) as { error: string; message: string }
    expect(a).toEqual(b)
    expect(a.error).toBe('bad_credentials')
    expect(nobody.headers.get('set-cookie')).toBeNull()
  })
})

describe('GET /v2/keys — what a door verifies with', () => {
  it('publishes the token key and the revoked device ids', async () => {
    const owner = await claim()
    const phone = device('phone', 'iPhone')
    await joinWithApproval(owner, phone)
    await call('DELETE', `/v2/me/devices/${phone.id}`, undefined, bearer(owner.token))

    const res = await call('GET', '/v2/keys')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { jwk: { kty: string }; revoked: string[] }
    expect(body.jwk.kty).toBe('OKP')
    expect(body.jwk).not.toHaveProperty('d')
    expect(body.revoked).toContain(phone.id)
  })
})

describe('GET /v2/me — the profile behind a session', () => {
  it('refuses without a token, and answers with one', async () => {
    const owner = await claim()
    const none = await call('GET', '/v2/me')
    expect(none.status).toBe(401)
    expect(((await none.json()) as { error: string }).error).toBe('unauthenticated')

    const res = await call('GET', '/v2/me', undefined, bearer(owner.token))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      username: string
      devices: { id: string; kind: string; current: boolean; lastSeenAt: number }[]
      desktops: unknown[]
    }
    expect(body.username).toBe(owner.username)
    expect(body.devices.find((d) => d.id === owner.deviceId)?.current).toBe(true)
    expect(body.desktops).toEqual([])
    expect(JSON.stringify(body)).not.toContain('password')
  })

  it('takes the session cookie as well as the Bearer', async () => {
    const owner = await claim()
    const res = await call('GET', '/v2/me', undefined, { cookie: `__Host-cr_session=${owner.token}` })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { username: string }).username).toBe(owner.username)
  })

  it('refuses a token that is not a session token', async () => {
    const res = await call('GET', '/v2/me', undefined, bearer('nonsense.nonsense'))
    expect(res.status).toBe(401)
  })
})

describe('PATCH /v2/me — a name and a face', () => {
  it('takes a display name and a small avatar and refuses the rest', async () => {
    const owner = await claim()
    const ok = await call('PATCH', '/v2/me', { displayName: 'Drej', avatar: `data:image/png;base64,${'A'.repeat(40)}` }, bearer(owner.token))
    expect(ok.status).toBe(200)
    const shown = (await (await call('GET', `/v2/accounts/${owner.username}`)).json()) as { displayName: string; avatar?: string }
    expect(shown.displayName).toBe('Drej')
    expect(shown.avatar).toContain('data:image/png')

    const big = await call('PATCH', '/v2/me', { avatar: `data:image/png;base64,${'A'.repeat(70_000)}` }, bearer(owner.token))
    expect(big.status).toBe(400)
    const long = await call('PATCH', '/v2/me', { displayName: 'x'.repeat(41) }, bearer(owner.token))
    expect(long.status).toBe(400)
  })
})

describe('devices', () => {
  it('lists them, revokes one, and refuses to revoke the last', async () => {
    const owner = await claim()
    const phone = device('phone', 'iPhone')
    await joinWithApproval(owner, phone)

    const listed = (await (await call('GET', '/v2/me/devices', undefined, bearer(owner.token))).json()) as {
      devices: { id: string }[]
    }
    expect(listed.devices.map((d) => d.id).sort()).toEqual([owner.deviceId, phone.id].sort())

    expect((await call('DELETE', `/v2/me/devices/${phone.id}`, undefined, bearer(owner.token))).status).toBe(204)
    const last = await call('DELETE', `/v2/me/devices/${owner.deviceId}`, undefined, bearer(owner.token))
    expect(last.status).toBe(409)
    const body = (await last.json()) as { error: string; message: string }
    expect(body.error).toBe('last_device')
    expect(body.message).toContain('last device')
    expect((await call('DELETE', `/v2/me/devices/${randomUUID()}`, undefined, bearer(owner.token))).status).toBe(404)
  })

  it('lets a device revoke ITSELF, which ends that session on the spot', async () => {
    const owner = await claim()
    const phone = device('phone', 'iPhone')
    const signedIn = (await (await joinWithApproval(owner, phone)).json()) as { token: string }

    const gone = await call('DELETE', `/v2/me/devices/${phone.id}`, undefined, bearer(signedIn.token))
    expect(gone.status).toBe(204)
    expect(gone.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await call('GET', '/v2/me', undefined, bearer(signedIn.token))).status).toBe(401)
    // The desktop's own session is untouched.
    expect((await call('GET', '/v2/me', undefined, bearer(owner.token))).status).toBe(200)
  })
})

describe('POST /v2/me/password', () => {
  it('changes it only with the current one, and the old one then opens nothing', async () => {
    const owner = await claim()
    const wrong = await call('POST', '/v2/me/password', { current: 'not it at all', next: 'a longer new password' }, bearer(owner.token))
    expect(wrong.status).toBe(401)
    const weak = await call('POST', '/v2/me/password', { current: PASSWORD, next: 'short' }, bearer(owner.token))
    expect(weak.status).toBe(400)
    expect(((await weak.json()) as { error: string; message: string }).error).toBe('weak_password')
    /**
     * THE SAME PASSWORD IS NOT A CHANGE. Answering 204 to one would be a lie
     * with consequences: this route ends every OTHER sitting as part of
     * changing a password, and somebody who came here because they think a
     * stranger has it would walk away believing that had been done.
     */
    const same = await call('POST', '/v2/me/password', { current: PASSWORD, next: PASSWORD }, bearer(owner.token))
    expect(same.status).toBe(400)
    const said = (await same.json()) as { error: string; message: string }
    expect(said.error).toBe('same_password')
    expect(said.message).toBe('That is the password you already have. Pick a different one.')
    const ok = await call('POST', '/v2/me/password', { current: PASSWORD, next: 'a longer new password' }, bearer(owner.token))
    expect(ok.status).toBe(204)

    const old = await call('POST', '/v2/sessions', { username: owner.username, password: PASSWORD, device: device('browser') })
    expect(old.status).toBe(401)
    // A new browser on an account that has a device is the ladder's own case:
    // the password is right, and it buys one more step.
    const now = await call('POST', '/v2/sessions', {
      username: owner.username,
      password: 'a longer new password',
      device: device('browser')
    })
    expect(now.status).toBe(401)
    expect(((await now.json()) as { error: string }).error).toBe('second_factor')
  })
})

describe('recovery codes', () => {
  it('shows eight once, and each opens the account exactly once', async () => {
    const owner = await claim()
    const res = await call('POST', '/v2/me/recovery-codes', {}, bearer(owner.token))
    expect(res.status).toBe(201)
    const { codes } = (await res.json()) as { codes: string[] }
    expect(codes).toHaveLength(8)
    for (const code of codes) expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)

    const laptop = device('browser', 'Chrome on macOS')
    const back = await call('POST', '/v2/recovery', { username: owner.username, code: codes[0], device: laptop })
    expect(back.status).toBe(201)
    const session = (await back.json()) as { token: string; deviceId: string }
    expect(session.deviceId).toBe(laptop.id)
    expect((await call('GET', '/v2/me', undefined, bearer(session.token))).status).toBe(200)

    const twice = await call('POST', '/v2/recovery', { username: owner.username, code: codes[0], device: device('browser') })
    expect(twice.status).toBe(401)
    expect(((await twice.json()) as { error: string }).error).toBe('bad_credentials')
  })
})

describe('PUT /v2/me/desktops/:deviceId', () => {
  it('is written by that desktop and by nobody else', async () => {
    const owner = await claim()
    const phone = device('phone', 'iPhone')
    const onPhone = (await (await joinWithApproval(owner, phone)).json()) as { token: string }

    const mine = await call(
      'PUT',
      `/v2/me/desktops/${owner.deviceId}`,
      { name: 'MacBook Pro', workspaces: [{ id: 'w1', name: 'Cookrew Dev' }] },
      bearer(owner.token)
    )
    expect(mine.status).toBe(204)

    const theirs = await call(
      'PUT',
      `/v2/me/desktops/${owner.deviceId}`,
      { name: 'Not mine', workspaces: [] },
      bearer(onPhone.token)
    )
    expect(theirs.status).toBe(403)

    const me = (await (await call('GET', '/v2/me', undefined, bearer(owner.token))).json()) as {
      desktops: { deviceId: string; name: string; workspaces: { id: string; name: string }[] }[]
    }
    expect(me.desktops).toHaveLength(1)
    expect(me.desktops[0].name).toBe('MacBook Pro')
    expect(me.desktops[0].workspaces).toEqual([{ id: 'w1', name: 'Cookrew Dev' }])

    const tooMany = await call(
      'PUT',
      `/v2/me/desktops/${owner.deviceId}`,
      { name: 'MacBook Pro', workspaces: Array.from({ length: 65 }, (_, i) => ({ id: `w${i}`, name: `W${i}` })) },
      bearer(owner.token)
    )
    expect(tooMany.status).toBe(400)
  })
})

describe('DELETE /v2/sessions/current — signing out', () => {
  it('clears the cookie and the token stops working', async () => {
    const owner = await claim()
    const out = await call('DELETE', '/v2/sessions/current', undefined, bearer(owner.token))
    expect(out.status).toBe(204)
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await call('GET', '/v2/me', undefined, bearer(owner.token))).status).toBe(401)
  })

  it('is also reachable as a POST, because a page can only send those', async () => {
    const owner = await claim()
    const out = await call('POST', '/v2/sessions/current', undefined, { cookie: `__Host-cr_session=${owner.token}` })
    expect(out.status).toBe(204)
    expect((await call('GET', '/v2/me', undefined, bearer(owner.token))).status).toBe(401)
  })
})

describe('a cookie-carried write from another site', () => {
  it('is refused when the Origin is not ours', async () => {
    const owner = await claim()
    const res = await call('PATCH', '/v2/me', { displayName: 'Taken over' }, {
      cookie: `__Host-cr_session=${owner.token}`,
      origin: 'https://evil.example'
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('bad_origin')
  })
})

describe('accountOf — v1 and v2 agree about who is reading', () => {
  it('answers whoami for a v2 session cookie and Bearer alike', async () => {
    const owner = await claim()
    const byCookie = await call('GET', '/v1/identity/whoami', undefined, { cookie: `__Host-cr_session=${owner.token}` })
    expect(byCookie.status).toBe(200)
    expect(((await byCookie.json()) as { sub: string }).sub).toBe(owner.username)

    const byBearer = await call('GET', '/v1/identity/whoami', undefined, bearer(owner.token))
    expect(((await byBearer.json()) as { sub: string }).sub).toBe(owner.username)
  })

  it('lets a v2 account star a team, and still refuses an unsigned one', async () => {
    const owner = await claim()
    const res = await call('POST', '/v1/doors/@somebody/alpha/star', undefined, bearer(owner.token))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { starred: boolean }).starred).toBe(true)
    const unsigned = await call('POST', '/v1/doors/@somebody/alpha/star')
    expect(unsigned.status).toBe(401)
  })
})

describe('the limiter', () => {
  let limited: Up
  afterEach(async () => {
    await limited.close()
  })

  it('refuses an eleventh account in a minute from one address', async () => {
    limited = await up()
    const codes: number[] = []
    for (let i = 0; i < 11; i++) {
      const res = await callOn(limited, 'POST', '/v2/accounts', { username: `x${i}`, password: PASSWORD, device: device() })
      codes.push(res.status)
    }
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true)
    expect(codes[10]).toBe(429)
  }, 20_000)

  it('counts a wrong password, and refuses a sixth try', async () => {
    limited = await up()
    await callOn(limited, 'POST', '/v2/accounts', { username: 'drej', password: PASSWORD, device: device() })
    const codes: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await callOn(limited, 'POST', '/v2/sessions', {
        username: 'drej',
        password: 'wrong password here',
        device: device('browser')
      })
      codes.push(res.status)
    }
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true)
    expect(codes[5]).toBe(429)
    const message = (await (
      await callOn(limited, 'POST', '/v2/sessions', { username: 'drej', password: PASSWORD, device: device('browser') })
    ).json()) as { error: string; message: string }
    expect(message.error).toBe('rate_limited')
  }, 20_000)
})

describe('every /v2 answer', () => {
  it('is private, uncached JSON', async () => {
    const owner = await claim()
    for (const [method, p, token] of [
      ['GET', '/v2/keys', undefined],
      ['GET', '/v2/me', owner.token],
      ['GET', '/v2/me/devices', owner.token],
      ['GET', '/v2/accounts/drej', undefined],
      ['GET', '/v2/nothing-here', undefined]
    ] as const) {
      const res = await call(method, p, undefined, token === undefined ? {} : bearer(token))
      expect(res.headers.get('cache-control'), p).toBe('private, no-store')
      expect(res.headers.get('content-type'), p).toContain('application/json')
    }
  })
})

describe('the security review’s findings, over HTTP', () => {
  it('does not let a forwarded header buy a fresh limiter window', async () => {
    const limited = await up()
    try {
      const codes: number[] = []
      for (let i = 0; i < 11; i++) {
        const res = await callOn(limited, 'POST', '/v2/accounts', {
          username: `spoof${i}`,
          password: PASSWORD,
          device: device()
        }, { 'x-forwarded-for': `198.51.100.${i}` })
        codes.push(res.status)
      }
      // A new address per request, and the eleventh is still refused: the key
      // is the socket, not a string the caller wrote.
      expect(codes[10]).toBe(429)
    } finally {
      await limited.close()
    }
  }, 20_000)

  it('bounds the free/taken lookup, so it cannot be walked', async () => {
    const limited = await up({ accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 3 })
    try {
      const codes: number[] = []
      for (let i = 0; i < 4; i++) {
        codes.push((await callOn(limited, 'HEAD', `/v2/accounts/who${i}`)).status)
      }
      expect(codes.slice(0, 3)).toEqual([404, 404, 404])
      expect(codes[3]).toBe(429)
    } finally {
      await limited.close()
    }
  })

  it('ends every other session when the password changes, keeping the caller’s', async () => {
    const owner = await claim()
    const phone = device('phone', 'iPhone')
    const onPhone = (await (await joinWithApproval(owner, phone)).json()) as { token: string }
    expect((await call('GET', '/v2/me', undefined, bearer(onPhone.token))).status).toBe(200)

    const changed = await call('POST', '/v2/me/password', { current: PASSWORD, next: 'a longer new password' }, bearer(owner.token))
    expect(changed.status).toBe(204)
    // The caller keeps working; the other sitting does not.
    expect((await call('GET', '/v2/me', undefined, bearer(owner.token))).status).toBe(200)
    expect((await call('GET', '/v2/me', undefined, bearer(onPhone.token))).status).toBe(401)

    // And a door verifying offline can see it: the ended session is published.
    const keys = (await (await call('GET', '/v2/keys')).json()) as { revoked: string[] }
    expect(keys.revoked.length).toBeGreaterThan(0)
    // The phone is still attached — the password changed, not the device.
    const me = (await (await call('GET', '/v2/me', undefined, bearer(owner.token))).json()) as {
      devices: { id: string }[]
    }
    expect(me.devices.map((d) => d.id)).toContain(phone.id)
  })

  it('ends every other session when a new sheet of recovery codes is taken', async () => {
    const owner = await claim()
    const phone = device('phone', 'iPhone')
    const onPhone = (await (await joinWithApproval(owner, phone)).json()) as { token: string }
    expect((await call('POST', '/v2/me/recovery-codes', {}, bearer(owner.token))).status).toBe(201)
    expect((await call('GET', '/v2/me', undefined, bearer(owner.token))).status).toBe(200)
    expect((await call('GET', '/v2/me', undefined, bearer(onPhone.token))).status).toBe(401)
  })

  it('treats a null Origin as another site, not as no site', async () => {
    const owner = await claim()
    const res = await call('PATCH', '/v2/me', { displayName: 'From a sandbox' }, {
      cookie: `__Host-cr_session=${owner.token}`,
      origin: 'null'
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('bad_origin')
  })
})
