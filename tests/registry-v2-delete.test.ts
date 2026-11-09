import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CertStore } from '../registry/src/cert-store'
import { DoorStore, type DoorInput } from '../registry/src/doors'
import { IdentityService } from '../registry/src/identity'
import { TransparencyLog } from '../registry/src/log'
import { PayoutStore } from '../registry/src/payouts'
import { ReceiptStore } from '../registry/src/receipts'
import { createRegistry } from '../registry/src/server'
import { StarStore } from '../registry/src/stars'
import { RegistryStore } from '../registry/src/store'
import { V2Accounts, V2_FILE } from '../registry/src/v2-accounts'
import { createV2, type V2Identity } from '../registry/src/v2-routes'
import { makeAuthorize, type PricingDeps } from '../registry/src/authorize'
import { MemoryPaymentNonces } from '../registry/src/terms'
import { STEP_UP_ENFORCEMENT } from '../src/shared/step-up'
import { PAYEE, loopbackOnly } from './support/pay-gate-fixture'

/**
 * DELETING AN ACCOUNT.
 *
 * What these hold is that the delete is real: it needs proof beyond a session,
 * it takes everything the page says it takes, and it leaves no way back in
 * through a token a door still honours or a name somebody else can claim.
 * Everything here is on loopback, against a data directory made for the test.
 */

const PASSWORD = 'correct horse battery staple'
const OTHER = 'a different long password'
const JWK = { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }

const listing = (handle: string, name: string): DoorInput => ({
  handle, name, title: name, door: `@${handle}/${name}`, agents: 1,
  address: 'https://example.test/door', transport: 'public', access: 'account', rails: []
})

const device = (name = 'MacBook Pro') => ({ id: randomUUID(), kind: 'desktop' as const, name, jwk: JWK })

let dir = ''
let origin = ''
let server: Server
let v2: V2Identity
let doors: DoorStore
let stars: StarStore
let identity: IdentityService
let payouts: PayoutStore
let receipts: ReceiptStore

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'v2-delete-'))
  v2 = createV2(dir, { secondStep: 'legacy', freshWindowMs: 0, limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
  doors = new DoorStore(dir, { allowPrivate: true })
  stars = new StarStore(dir)
  identity = new IdentityService(dir)
  payouts = new PayoutStore(dir)
  receipts = new ReceiptStore(dir)
  const store = new RegistryStore(dir)
  const pricing: PricingDeps = {
    payouts,
    config: { chain: 'base', ttlMs: 60_000 },
    nonces: new MemoryPaymentNonces(),
    facilitator: null,
    receipts,
    now: () => Date.now()
  }
  server = createRegistry({
    store,
    log: new TransparencyLog(dir),
    identity,
    doors,
    stars,
    pricing,
    relay: true,
    v2,
    authorize: makeAuthorize(store, identity, pricing)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = loopbackOnly(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  rmSync(dir, { recursive: true, force: true })
})

const call = (method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${origin}${route}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
const errorOf = async (res: Response): Promise<string> => ((await res.json()) as { error: string }).error

async function claim(username: string): Promise<{ username: string; token: string; deviceId: string }> {
  const one = device()
  const res = await call('POST', '/v2/accounts', { username, password: PASSWORD, device: one })
  expect(res.status).toBe(201)
  return { username, token: ((await res.json()) as { session: { token: string } }).session.token, deviceId: one.id }
}

async function secondDevice(owner: { token: string }): Promise<{ token: string; deviceId: string }> {
  const minted = await call('POST', '/v2/me/join-codes', { current: PASSWORD }, bearer(owner.token))
  const { code } = (await minted.json()) as { code: string }
  const two = device('Mac Studio')
  const joined = await call('POST', '/v2/join', { code, device: two })
  expect(joined.status).toBe(201)
  return { token: ((await joined.json()) as { token: string }).token, deviceId: two.id }
}

const remove = (token: string, proof: Record<string, unknown>, username: string): Promise<Response> =>
  call('DELETE', '/v2/me', { confirm: username, ...proof }, bearer(token))

describe('who may delete', () => {
  it('is on the step-up list, behind the gate', () => {
    expect(STEP_UP_ENFORCEMENT['delete-account']).toBe('gate')
  })

  it('refuses a stranger', async () => {
    expect((await call('DELETE', '/v2/me', { confirm: 'drej', current: PASSWORD })).status).toBe(401)
  })

  it('refuses a session alone, which is what a stolen one is', async () => {
    const owner = await claim('drej')
    const res = await remove(owner.token, {}, 'drej')
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toBe('password_required')
    expect(v2.accounts.get('drej')).not.toBeNull()
  })

  it('refuses a wrong password and changes nothing', async () => {
    const owner = await claim('drej')
    const res = await remove(owner.token, { current: OTHER }, 'drej')
    expect(res.status).toBe(401)
    expect(v2.accounts.get('drej')).not.toBeNull()
  })

  it('refuses a right password with the wrong name typed, and asks for no proof first', async () => {
    const owner = await claim('drej')
    const res = await remove(owner.token, { current: PASSWORD }, 'someone-else')
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('confirm_mismatch')
    expect(v2.accounts.get('drej')).not.toBeNull()
  })

  it('refuses a write from another site', async () => {
    const owner = await claim('drej')
    const res = await call('DELETE', '/v2/me', { confirm: 'drej', current: PASSWORD }, { ...bearer(owner.token), origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(v2.accounts.get('drej')).not.toBeNull()
  })

  it('refuses while the not-me alarm is up, since a stranger may hold the password', async () => {
    const owner = await claim('drej')
    v2.factors.store.setMustChangePassword('drej', true)
    const res = await remove(owner.token, { current: PASSWORD }, 'drej')
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toBe('password_change_required')
    expect(v2.accounts.get('drej')).not.toBeNull()
  })

  it('takes a second factor as proof, in place of the password', async () => {
    const owner = await claim('drej')
    const { secret } = (await (await call('POST', '/v2/me/totp/enrol', { current: PASSWORD }, bearer(owner.token))).json()) as { secret: string }
    const { base32Decode, totpAt, TOTP_STEP_MS } = await import('../registry/src/v2-totp')
    const code = (shift: number): string => totpAt(base32Decode(secret) as Buffer, Date.now() + shift * TOTP_STEP_MS)
    expect((await call('POST', '/v2/me/totp/confirm', { code: code(-1) }, bearer(owner.token))).status).toBe(204)

    const asked = await remove(owner.token, {}, 'drej')
    expect(asked.status).toBe(401)
    const step = (await asked.json()) as { error: string; act: string; pending: string }
    expect(step).toMatchObject({ error: 'step_up', act: 'delete-account' })
    const climbed = await call('POST', `/v2/sessions/${step.pending}/totp`, { code: code(0) })
    expect(climbed.status).toBeLessThan(300)
    expect((await remove(owner.token, { stepUp: step.pending }, 'drej')).status).toBe(204)
    expect(v2.accounts.get('drej')).toBeNull()
  })
})

describe('what a delete takes', () => {
  it('ends every session on every device at once', async () => {
    const owner = await claim('drej')
    const other = await secondDevice(owner)
    const res = await remove(owner.token, { current: PASSWORD }, 'drej')
    expect(res.status).toBe(204)
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    expect((await call('GET', '/v2/me', undefined, bearer(owner.token))).status).toBe(401)
    expect((await call('GET', '/v2/me', undefined, bearer(other.token))).status).toBe(401)
    expect((await call('POST', '/v2/sessions', { username: 'drej', password: PASSWORD, device: device() })).status).toBeGreaterThanOrEqual(400)
  })

  it('keeps every token revoked for the doors that check offline, across a restart', async () => {
    const owner = await claim('drej')
    const other = await secondDevice(owner)
    await remove(owner.token, { current: PASSWORD }, 'drej')
    const { revoked } = (await (await call('GET', '/v2/keys')).json()) as { revoked: string[] }
    expect(revoked).toEqual(expect.arrayContaining([owner.deviceId, other.deviceId]))
    expect(new V2Accounts(dir).revokedIds()).toEqual(expect.arrayContaining([owner.deviceId, other.deviceId]))
  })

  it('stops publishing those ids once no token they name can still be alive', async () => {
    const owner = await claim('drej')
    await remove(owner.token, { current: PASSWORD }, 'drej')
    const later = new V2Accounts(dir, () => Date.now() + 40 * 24 * 60 * 60 * 1000)
    expect(later.revokedIds()).toEqual([])
    expect(later.isRetired('drej')).toBe(true)
  })

  it('removes desktops from the index the name zone reads', async () => {
    const owner = await claim('drej')
    const filed = await call('PUT', `/v2/me/desktops/${owner.deviceId}`, { name: 'Studio', workspaces: [] }, bearer(owner.token))
    expect(filed.status).toBe(204)
    expect(v2.accounts.desktopFor(owner.deviceId)).not.toBeNull()
    await remove(owner.token, { current: PASSWORD }, 'drej')
    expect(v2.accounts.desktopFor(owner.deviceId)).toBeNull()
  })

  it('removes the sign-in factors with the account', async () => {
    const owner = await claim('drej')
    await call('POST', '/v2/me/totp/enrol', { current: PASSWORD }, bearer(owner.token))
    await remove(owner.token, { current: PASSWORD }, 'drej')
    expect(readFileSync(path.join(dir, 'factors-v2.json'), 'utf8')).not.toContain('drej')
  })

  it('withdraws team listings, and takes the stars on them and by this account', async () => {
    const owner = await claim('drej')
    await claim('fan')
    doors.register('drej', listing('drej', 'alpha'))
    doors.register('fan', listing('fan', 'beta'))
    expect(doors.get('drej', 'alpha')).not.toBeNull()
    stars.toggle('fan', 'drej', 'alpha')
    stars.toggle('drej', 'fan', 'beta')
    await remove(owner.token, { current: PASSWORD }, 'drej')
    expect(doors.get('drej', 'alpha')).toBeNull()
    expect(doors.get('fan', 'beta')).not.toBeNull()
    expect(stars.count('drej', 'alpha')).toBe(0)
    expect(stars.count('fan', 'beta')).toBe(0)
  })

  it('takes the older key record and the payout address, and that key cannot enrol again', async () => {
    const owner = await claim('drej')
    identity.register('drej', JWK)
    payouts.bind('drej', PAYEE)
    await remove(owner.token, { current: PASSWORD }, 'drej')
    expect(identity.known('drej')).toBe(false)
    expect(payouts.addressOf('drej')).toBeNull()
    const again = await call('POST', '/v1/identity/register', { credentialId: 'drej', publicKeyJwk: JWK })
    expect(again.status).toBe(409)
  })

  it('leaves the username readable nowhere in the account file', async () => {
    const owner = await claim('drej-unique-name')
    await remove(owner.token, { current: PASSWORD }, 'drej-unique-name')
    expect(readFileSync(path.join(dir, V2_FILE), 'utf8')).not.toContain('drej-unique-name')
  })
})

describe('what a delete leaves', () => {
  it('ends every seat, and keeps only the bought ones as a record of the sale', async () => {
    const owner = await claim('drej')
    const bought = v2.seats.settle({ team: '@other/crew', account: 'drej', by: 'stripe', receipt: 'cs_test_1' })
    expect(bought.ok).toBe(true)
    const granted = v2.seats.grant({ team: '@other/gift', account: 'drej', by: 'other' })
    expect(granted.ok).toBe(true)
    const sold = v2.seats.settle({ team: '@drej/alpha', account: 'buyer', by: 'stripe', receipt: 'cs_test_2' })
    expect(sold.ok).toBe(true)
    v2.seats.grant({ team: '@drej/alpha', account: 'friend', by: 'drej' })

    await remove(owner.token, { current: PASSWORD }, 'drej')

    expect(v2.seats.activeFor('@other/crew', 'drej')).toBeNull()
    expect(v2.seats.activeFor('@other/gift', 'drej')).toBeNull()
    expect(v2.seats.activeFor('@drej/alpha', 'buyer')).toBeNull()
    expect(v2.seats.activeFor('@drej/alpha', 'friend')).toBeNull()
    const kept = [...v2.seats.heldBy('drej'), ...v2.seats.forTeam('@drej/alpha')]
    expect(kept.map((seat) => seat.receipt).filter(Boolean).sort()).toEqual(['cs_test_1', 'cs_test_2'])
    expect(kept.every((seat) => seat.source === 'bought' && seat.endedAt !== undefined)).toBe(true)
  })

  it('keeps preset receipts for the accounts', async () => {
    const owner = await claim('drej')
    receipts.record({
      identityId: 'drej', lineage: 'l', version: 1, presetId: 'p', nonce: 'n', tx: '0xt',
      amount: '12.00', asset: 'USDC', at: 1, verified: true
    })
    await remove(owner.token, { current: PASSWORD }, 'drej')
    expect(receipts.forLineage('drej', 'l')).toHaveLength(1)
  })

  it('never lets the name be taken again, by password, lookup or v1 key', async () => {
    const owner = await claim('drej')
    await remove(owner.token, { current: PASSWORD }, 'drej')
    const again = await call('POST', '/v2/accounts', { username: 'drej', password: PASSWORD, device: device() })
    expect(again.status).toBe(409)
    expect((await call('HEAD', '/v2/accounts/drej')).status).toBe(410)
    expect(new V2Accounts(dir).isRetired('drej')).toBe(true)
  })
})

describe('forgetting a certificate', () => {
  it('removes the record, and a CA answer already on its way cannot bring it back', () => {
    const certs = new CertStore(dir)
    certs.beginOrder('mac-1', 'order-1')
    certs.publish('mac-1', ['digest'])
    certs.forget('mac-1')
    expect(certs.textsFor('mac-1')).toEqual([])
    expect(certs.state('mac-1')).toEqual({ status: 'none' })
    certs.fail('mac-1', 'late')
    expect(readFileSync(path.join(dir, 'certs.json'), 'utf8')).not.toContain('mac-1')
  })
})

describe('a line nobody listed', () => {
  const ticket = async (token: string, name: string): Promise<string> => {
    const res = await call('POST', '/v1/relay/ticket', { name }, bearer(token))
    expect(res.status).toBe(200)
    return ((await res.json()) as { ticket: string }).ticket
  }

  it('ends with the account, and a ticket minted before the delete opens nothing', async () => {
    const owner = await claim('drej')
    const held = await ticket(owner.token, '@drej/ghost')
    const spare = await ticket(owner.token, '@drej/spare')
    const down = await fetch(`${origin}/v1/relay/door?ticket=${encodeURIComponent(held)}`)
    expect(down.status).toBe(200)
    const reader = (down.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()

    expect((await remove(owner.token, { current: PASSWORD }, 'drej')).status).toBe(204)

    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    expect((await fetch(`${origin}/v1/relay/door?ticket=${encodeURIComponent(spare)}`)).status).toBe(401)
  })
})

describe('what proves a delete', () => {
  it('never offers the approve rung: another device sees a join prompt, not this', async () => {
    const owner = await claim('drej')
    await secondDevice(owner)
    const codes = await call('POST', '/v2/me/recovery-codes', { current: PASSWORD }, bearer(owner.token))
    expect(codes.status).toBe(201)
    const res = await remove(owner.token, {}, 'drej')
    expect(res.status).toBe(401)
    const step = (await res.json()) as { next: string[]; match?: string }
    expect(step.next).not.toContain('approve')
    expect(step.match).toBeUndefined()
  })

  it('counts guesses at the password, so a stolen session cannot try forever', async () => {
    const tight = createV2(mkdtempSync(path.join(tmpdir(), 'v2-delete-tight-')), { secondStep: 'legacy', freshWindowMs: 0, limits: { sessionsPerMinute: 2, accountsPerMinute: 100 } })
    const local = createRegistry({ store: new RegistryStore(dir), log: new TransparencyLog(dir), identity, v2: tight })
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve))
    const at = loopbackOnly(`http://127.0.0.1:${(local.address() as AddressInfo).port}`)
    try {
      const one = device()
      const made = await fetch(`${at}/v2/accounts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'drej', password: PASSWORD, device: one })
      })
      const { session } = (await made.json()) as { session: { token: string } }
      const guess = (): Promise<Response> =>
        fetch(`${at}/v2/me`, {
          method: 'DELETE', headers: { 'content-type': 'application/json', ...bearer(session.token) },
          body: JSON.stringify({ confirm: 'drej', current: OTHER })
        })
      expect((await guess()).status).toBe(401)
      expect((await guess()).status).toBe(401)
      expect((await guess()).status).toBe(429)
      // Counted per sitting, so burning it leaves the owner's other session free.
      const again = await fetch(`${at}/v2/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'drej', password: PASSWORD, device: one })
      })
      expect(again.status).toBe(201)
      const other = ((await again.json()) as { token: string }).token
      const change = await fetch(`${at}/v2/me/password`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...bearer(other) },
        body: JSON.stringify({ current: OTHER, next: 'a brand new long password' })
      })
      expect(change.status).toBe(401)
    } finally {
      local.closeAllConnections()
      local.close()
    }
  })
})

describe('when a write fails partway', () => {
  it('leaves the account in place, so its owner can simply ask again', async () => {
    await claim('drej')
    const failing = new V2Accounts(dir)
    expect(failing.get('drej')).not.toBeNull()
    rmSync(dir, { recursive: true, force: true })
    expect(() => failing.close('drej')).toThrow()
    expect(failing.get('drej')).not.toBeNull()
    expect(failing.isRetired('drej')).toBe(false)
  })
})

describe('a Mac that missed the delete', () => {
  it('can ask whether the name is gone, and a name nobody ever held is plain 404', async () => {
    const owner = await claim('drej')
    await remove(owner.token, { current: PASSWORD }, 'drej')
    const asked = await call('GET', '/v2/accounts/drej')
    expect(asked.status).toBe(410)
    expect(await errorOf(asked)).toBe('account_deleted')
    expect((await call('GET', '/v2/accounts/never-held')).status).toBe(404)
  })
})
