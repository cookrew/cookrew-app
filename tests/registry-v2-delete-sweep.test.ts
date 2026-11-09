import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeAuthorize, type PricingDeps } from '../registry/src/authorize'
import { DoorStore, type DoorInput } from '../registry/src/doors'
import { FunnelCounts } from '../registry/src/funnel-counts'
import { IdentityService } from '../registry/src/identity'
import { TransparencyLog } from '../registry/src/log'
import { FilePaymentNonces } from '../registry/src/payment-nonces'
import { PayoutStore } from '../registry/src/payouts'
import { Pulse } from '../registry/src/pulse'
import { ReceiptStore } from '../registry/src/receipts'
import { createRegistry } from '../registry/src/server'
import { StarStore } from '../registry/src/stars'
import { RegistryStore } from '../registry/src/store'
import { createV2, type V2Identity } from '../registry/src/v2-routes'
import { createLineSeen } from '../registry/src/v2-line-seen'
import { PAYEE, loopbackOnly } from './support/pay-gate-fixture'

/**
 * BOX ROUND 3, BUG 4. The sheet says the account file keeps only a digest, and
 * a deleted name sat in plain text in canvas-line-seen.json for a device that
 * had signed out before the delete. So this reads EVERY file in the data
 * directory, against the same stores main.ts builds, rather than one file at a
 * time: a store added next year is covered by being in the folder.
 *
 * The kept records are the ones src/shared/account-delete.ts tells a person
 * about. Everything here is on loopback, in a directory made for the test.
 */

const NAME = 'zephyrine'
const PASSWORD = 'correct horse battery staple'
const JWK = { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }

const listing = (handle: string, name: string): DoorInput => ({
  handle, name, title: name, door: `@${handle}/${name}`, agents: 1,
  address: 'https://example.test/door', transport: 'public', access: 'account', rails: []
})
const device = (name: string) => ({ id: randomUUID(), kind: 'desktop' as const, name, jwk: JWK })

interface Up {
  origin: string
  v2: V2Identity
  doors: DoorStore
  stars: StarStore
  identity: IdentityService
  payouts: PayoutStore
  pulse: Pulse
  close: () => Promise<void>
}

let dir = ''
let up: Up
const seenFile = (): string => path.join(dir, 'canvas-line-seen.json')

/** The stores main.ts builds, on one directory. */
async function boot(): Promise<Up> {
  const v2 = createV2(dir, { secondStep: 'legacy', limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
  const identity = new IdentityService(dir)
  const store = new RegistryStore(dir)
  const payouts = new PayoutStore(dir)
  const doors = new DoorStore(dir, { allowPrivate: true })
  const stars = new StarStore(dir)
  const pulse = new Pulse(dir)
  const pricing: PricingDeps = {
    payouts,
    config: { chain: 'base', ttlMs: 60_000 },
    nonces: new FilePaymentNonces(dir),
    facilitator: null,
    receipts: new ReceiptStore(dir),
    now: () => Date.now()
  }
  const server: Server = createRegistry({
    store,
    log: new TransparencyLog(dir),
    identity,
    pricing,
    doors,
    stars,
    pulse,
    relay: true,
    v2,
    funnel: { counts: new FunnelCounts(dir), owner: '', trustedProxies: [] },
    lineSeenFile: seenFile(),
    authorize: makeAuthorize(store, identity, pricing)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: loopbackOnly(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    v2, doors, stars, identity, payouts, pulse,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

const call = (method: string, route: string, body?: unknown, token?: string): Promise<Response> =>
  fetch(`${up.origin}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })

async function claim(username: string): Promise<{ token: string; deviceId: string }> {
  const one = device('Desk')
  const res = await call('POST', '/v2/accounts', { username, password: PASSWORD, device: one })
  expect(res.status).toBe(201)
  return { token: ((await res.json()) as { session: { token: string } }).session.token, deviceId: one.id }
}

async function join(token: string): Promise<{ token: string; deviceId: string }> {
  const minted = await call('POST', '/v2/me/join-codes', { current: PASSWORD }, token)
  const { code } = (await minted.json()) as { code: string }
  const two = device('Studio')
  const joined = await call('POST', '/v2/join', { code, device: two })
  expect(joined.status).toBe(201)
  return { token: ((await joined.json()) as { token: string }).token, deviceId: two.id }
}

/** Every file under the data directory holding the name, in its bytes or its own name. */
function filesHolding(name: string): string[] {
  const walk = (at: string): string[] =>
    readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(at, entry.name)
      return entry.isDirectory() ? walk(full) : [full]
    })
  const wanted = name.toLowerCase()
  return walk(dir)
    .filter((file) => file.toLowerCase().includes(wanted) || readFileSync(file).toString('latin1').toLowerCase().includes(wanted))
    .map((file) => path.relative(dir, file))
}

/** One device signed out before the delete, its line last seen by an earlier run. */
async function accountWithASignedOutDesktop(): Promise<{ token: string; deviceId: string; gone: string }> {
  const owner = await claim(NAME)
  const second = await join(owner.token)
  expect((await call('DELETE', `/v2/me/devices/${second.deviceId}`, { current: PASSWORD }, owner.token)).status).toBeLessThan(300)
  await up.close()
  writeFileSync(
    seenFile(),
    JSON.stringify({ [`@${NAME}/desktop/${owner.deviceId}`]: Date.now(), [`@${NAME}/desktop/${second.deviceId}`]: Date.now() })
  )
  up = await boot()
  return { ...owner, gone: second.deviceId }
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'v2-delete-sweep-'))
  up = await boot()
})

afterEach(async () => {
  await up?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('a deleted name, read for in every file', () => {
  it('is in no file, down to a desktop that signed out before the delete', async () => {
    const owner = await accountWithASignedOutDesktop()
    await claim('neighbour')
    up.doors.register(NAME, listing(NAME, 'alpha'))
    up.doors.register('neighbour', listing('neighbour', 'beta'))
    up.stars.toggle('neighbour', NAME, 'alpha')
    up.stars.toggle(NAME, 'neighbour', 'beta')
    up.identity.register(NAME, JWK)
    up.payouts.bind(NAME, PAYEE)
    up.pulse.door(`@${NAME}/alpha`, 'line')
    up.pulse.door('@neighbour/beta', 'line')
    up.pulse.page(`/${NAME}/alpha`)
    up.pulse.page('/market')
    await up.pulse.flush()
    expect(filesHolding(NAME).length).toBeGreaterThan(1)

    const res = await call('DELETE', '/v2/me', { confirm: NAME, current: PASSWORD }, owner.token)
    expect(res.status).toBe(204)
    await up.pulse.flush()
    await up.close()

    expect(filesHolding(NAME)).toEqual([])
    up = await boot()
  })

  it('leaves what is another person’s', async () => {
    const owner = await accountWithASignedOutDesktop()
    up.pulse.door('@neighbour/beta', 'line')
    up.pulse.page('/neighbour/beta')
    up.pulse.page('/market')
    await call('DELETE', '/v2/me', { confirm: NAME, current: PASSWORD }, owner.token)
    await up.pulse.flush()
    expect(up.pulse.doorToday('@neighbour/beta').lines).toBe(1)
    expect(readFileSync(path.join(dir, 'pulse.json'), 'utf8')).toContain('/neighbour/beta')
    expect(readFileSync(path.join(dir, 'pulse.json'), 'utf8')).toContain('/market')
  })

  it('is kept only where the delete sheet says, for a sale someone else must account for', async () => {
    const owner = await claim(NAME)
    expect(up.v2.seats.settle({ team: '@other/crew', account: NAME, by: 'stripe', receipt: 'cs_test_1' }).ok).toBe(true)
    await call('DELETE', '/v2/me', { confirm: NAME, current: PASSWORD }, owner.token)
    expect(filesHolding(NAME)).toEqual(['seats-v2.json'])
  })
})

describe('line sightings left by a build before this one', () => {
  it('a registry that boots drops the lines of a deleted account, and keeps the living', async () => {
    const owner = await claim(NAME)
    await claim('neighbour')
    await call('DELETE', '/v2/me', { confirm: NAME, current: PASSWORD }, owner.token)
    await up.close()
    const living = `@neighbour/desktop/${randomUUID()}`
    writeFileSync(seenFile(), JSON.stringify({ [`@${NAME}/desktop/${randomUUID()}`]: Date.now(), [living]: Date.now() }))
    up = await boot()
    const held = readFileSync(seenFile(), 'utf8')
    expect(held).not.toContain(NAME)
    expect(held).toContain(living)
  })
})

describe('createLineSeen.forgetWhere', () => {
  it('forgets what the test names, and writes at once', () => {
    const file = path.join(dir, 'seen.json')
    const seen = createLineSeen(file, () => 1000)
    seen.see('@a/desktop/1')
    seen.see('@a/desktop/2')
    seen.see('@ab/desktop/3')
    seen.forgetWhere((name) => name.startsWith('@a/'))
    expect(existsSync(file)).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')) as object)).toEqual(['@ab/desktop/3'])
  })
})
