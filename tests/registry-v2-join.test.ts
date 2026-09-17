import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import { JoinCodes, JOIN_CODE_TTL_MS } from '../registry/src/v2-join-codes'

/**
 * JOINING FROM A DEVICE YOU ALREADY HOLD.
 *
 * The rule being proved is the security model's third line: a password alone
 * never attaches a device. Everything below is one of the two halves of the
 * only other way in — a code minted where trust already is, and spent once on
 * a machine that types nothing else.
 */

const PASSWORD = 'correct horse battery staple'

const device = (kind: 'desktop' | 'phone' | 'browser' = 'desktop', name = 'Mac mini') => ({
  id: randomUUID(),
  kind,
  name,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

/* ── the store, on its own ─────────────────────────────────────────────────── */

describe('the join-code store', () => {
  it('mints eight characters a person can read off a screen', () => {
    const code = new JoinCodes().mint('drej').code
    // Two blocks of four, and never a character that is two characters: no
    // 0/O, no 1/I/L. The same alphabet a recovery code uses, for the same job.
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
  })

  it('KEEPS ONE LIVE PER ACCOUNT — the second screen is the only one that works', () => {
    const codes = new JoinCodes()
    const first = codes.mint('drej')
    const second = codes.mint('drej')
    expect(second.code).not.toBe(first.code)
    // Two live codes would be two chances for a shoulder-surfed screen to
    // still be good; the owner is looking at the newest one.
    expect(codes.redeem(first.code)).toBeNull()
    expect(codes.redeem(second.code)).toBe('drej')
  })

  it('is one-shot, and dead the moment it is read', () => {
    const codes = new JoinCodes()
    const { code } = codes.mint('drej')
    expect(codes.redeem(code)).toBe('drej')
    expect(codes.redeem(code)).toBeNull()
  })

  it('forgives the case and the dash, because people retype what they see', () => {
    const codes = new JoinCodes()
    const { code } = codes.mint('drej')
    expect(codes.redeem(code.toLowerCase().replace('-', ' '))).toBe('drej')
  })

  it('reads an expired code as gone', () => {
    let clock = 1_000
    const codes = new JoinCodes(() => clock)
    const { code } = codes.mint('drej')
    clock += JOIN_CODE_TTL_MS
    expect(codes.redeem(code)).toBeNull()
    expect(codes.liveFor('drej')).toBeNull()
  })

  it('answers null to anything that is not a code', () => {
    const codes = new JoinCodes()
    codes.mint('drej')
    for (const bad of [undefined, null, 42, '', '----', 'ZZZZ-ZZZZ']) {
      expect(codes.redeem(bad)).toBeNull()
    }
  })

  it('does not open another account', () => {
    const codes = new JoinCodes()
    const mine = codes.mint('drej')
    codes.mint('stranger')
    expect(codes.redeem(mine.code)).toBe('drej')
  })
})

/* ── both routes, on the real router ───────────────────────────────────────── */

interface Up {
  origin: string
  close: () => Promise<void>
}

/**
 * `loose` leaves the join limiter out of the way. Every test here calls from
 * 127.0.0.1, so one shared registry would have them spending each other's five
 * tries; the test that proves the cap builds its own with the real default.
 */
async function up(loose = true): Promise<Up> {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-join-'))
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    // Loose on the sign-in limiter, which has its own proof elsewhere, and
    // DEFAULT on the two this file is about.
    v2: createV2(dir, {
      limits: {
        accountsPerMinute: 1000,
        sessionsPerMinute: 1000,
        ...(loose ? { joinPerMinute: 1000 } : {})
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://127.0.0.1:${port}`,
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
  site = await up()
})
afterAll(async () => {
  await site.close()
})

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${site.origin}${p}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  })
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T

let minted = 0
async function claim(): Promise<{ username: string; token: string }> {
  const username = `joiner${++minted}`
  const res = await call('POST', '/v2/accounts', { username, password: PASSWORD, device: device() })
  expect(res.status).toBe(201)
  const out = await bodyOf<{ session: { token: string } }>(res)
  return { username, token: out.session.token }
}

const mintCode = async (token: string): Promise<string> => {
  const res = await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(token))
  expect(res.status).toBe(201)
  return (await bodyOf<{ code: string }>(res)).code
}

describe('POST /v2/me/join-codes — minting where the trust already is', () => {
  it('needs a session at all', async () => {
    expect((await call('POST', '/v2/me/join-codes', { current: PASSWORD })).status).toBe(401)
  })

  it('STEPS UP: a session alone does not widen what the account opens from', async () => {
    const owner = await claim()
    const bare = await call('POST', '/v2/me/join-codes', {}, bearer(owner.token))
    expect(bare.status).toBe(403)
    expect((await bodyOf<{ error: string }>(bare)).error).toBe('password_required')
    expect((await call('POST', '/v2/me/join-codes', { current: 'wrong' }, bearer(owner.token))).status).toBe(401)
  })

  it('answers the code and when it dies', async () => {
    const owner = await claim()
    const res = await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner.token))
    expect(res.status).toBe(201)
    const out = await bodyOf<{ code: string; expiresAt: number }>(res)
    expect(out.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
    expect(out.expiresAt).toBeGreaterThan(Date.now())
    expect(out.expiresAt).toBeLessThanOrEqual(Date.now() + JOIN_CODE_TTL_MS)
  })

  it('caps minting at six an hour for one account', async () => {
    const owner = await claim()
    for (let i = 0; i < 6; i += 1) {
      expect((await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner.token))).status).toBe(201)
    }
    const seventh = await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner.token))
    expect(seventh.status).toBe(429)
    expect(seventh.headers.get('retry-after')).toBe('3600')
    // Another account is untouched: the ceiling is per account, not global.
    const other = await claim()
    expect((await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(other.token))).status).toBe(201)
  })
})

describe('POST /v2/join — the new machine types the code and nothing else', () => {
  it('attaches the device and hands it its own session', async () => {
    const owner = await claim()
    const code = await mintCode(owner.token)
    const joining = device('desktop', 'Mac Studio')

    const res = await call('POST', '/v2/join', { code, device: joining })
    expect(res.status).toBe(201)
    const out = await bodyOf<{ token: string; deviceId: string; username: string }>(res)
    expect(out.deviceId).toBe(joining.id)
    expect(out.username).toBe(owner.username)
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')

    // The session it was handed is a real one, and the account now lists it.
    const me = await bodyOf<{ devices: { id: string }[] }>(
      await call('GET', '/v2/me', undefined, bearer(out.token))
    )
    expect(me.devices.map((d) => d.id)).toContain(joining.id)
  })

  it('THE CODE IS DEAD WHATEVER HAPPENED NEXT — even when the device was not', async () => {
    const owner = await claim()
    const code = await mintCode(owner.token)

    // A body the attach cannot use. The code is spent before the device is
    // looked at, so a caller cannot retry it with a better-formed one.
    const bad = await call('POST', '/v2/join', { code, device: { id: 'not-a-device' } })
    expect(bad.status).toBe(400)
    const again = await call('POST', '/v2/join', { code, device: device() })
    expect(again.status).toBe(401)
  })

  it('refuses a code that was never minted, and one already spent', async () => {
    const owner = await claim()
    const code = await mintCode(owner.token)
    expect((await call('POST', '/v2/join', { code, device: device() })).status).toBe(201)
    expect((await call('POST', '/v2/join', { code, device: device() })).status).toBe(401)
    expect((await call('POST', '/v2/join', { code: 'ZZZZ-ZZZZ', device: device() })).status).toBe(401)
  })

  it('caps wrong codes from one address at five a minute', async () => {
    // Its own registry, so the count is this test's alone — the limiter is
    // keyed by address and every test here shares 127.0.0.1.
    const solo = await up(false)
    try {
      for (let i = 0; i < 5; i += 1) {
        const res = await fetch(`${solo.origin}/v2/join`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: 'ZZZZ-ZZZZ', device: device() })
        })
        expect(res.status).toBe(401)
      }
      const sixth = await fetch(`${solo.origin}/v2/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'ZZZZ-ZZZZ', device: device() })
      })
      expect(sixth.status).toBe(429)
      expect(sixth.headers.get('retry-after')).toBe('60')
    } finally {
      await solo.close()
    }
  })
})
