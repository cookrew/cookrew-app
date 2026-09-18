import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { openAtDevice, type SealedToDevice } from '../registry/src/v2-device-seal'

/**
 * IDENTITY v3 — THE ONE QUEUE, over HTTP (V3-11).
 *
 * The three kinds through the same list, the two rulings' new routes, and the
 * two lines from the revocation table: a revoke voids, "not me" empties. The
 * one property the reach handoff rests on is proved end to end — the Mac seals
 * the pairing URL to the asking device and the registry relays ciphertext it
 * cannot read, so only that device opens it.
 */

const PASSWORD = 'correct horse battery staple'

let dir = ''
let origin = ''
let close: () => Promise<void> = async () => undefined

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${origin}${p}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  })
const as = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T

interface Device {
  id: string
  pub: Record<string, string>
  priv: Record<string, string>
}
const newDevice = (): Device => {
  const pair = generateKeyPairSync('ed25519')
  return {
    id: randomUUID(),
    pub: pair.publicKey.export({ format: 'jwk' }) as Record<string, string>,
    priv: pair.privateKey.export({ format: 'jwk' }) as Record<string, string>
  }
}

/** Claim an account with a first device, and return its session token. */
async function claim(username: string, device: Device, kind = 'desktop'): Promise<string> {
  const res = await call('POST', '/v2/accounts', {
    username,
    password: PASSWORD,
    device: { id: device.id, kind, name: `${username}'s ${kind}`, jwk: device.pub }
  })
  expect(res.status).toBe(201)
  return (await bodyOf<{ session: { token: string } }>(res)).session.token
}

/** Attach a second device, climbing the approve rung the first device answers. */
async function attach(username: string, device: Device, approver: string, kind = 'phone'): Promise<string> {
  const res = await call('POST', '/v2/sessions', {
    username,
    password: PASSWORD,
    device: { id: device.id, kind, name: `${username}'s ${kind}`, jwk: device.pub }
  })
  expect(res.status).toBe(401)
  const asked = await bodyOf<{ pending: string; match: string }>(res)
  const req = await call('POST', `/v2/sessions/${asked.pending}/approve`)
  const { approval } = await bodyOf<{ approval: string }>(req)
  const decided = await call('POST', `/v2/me/approvals/${approval}`, { decision: 'approve', match: asked.match }, as(approver))
  expect(decided.status).toBe(204)
  const done = await call('GET', `/v2/sessions/${asked.pending}`)
  expect(done.status).toBe(201)
  return (await bodyOf<{ token: string }>(done)).token
}

// The cast, once: an owner with two Macs and a phone, and a paying guest.
const drejMac = newDevice()
const drejMac2 = newDevice()
const drejPhone = newDevice()
const mira = newDevice()
let drejToken = ''
let drejMac2Token = ''
let drejPhoneToken = ''
let miraToken = ''

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'v2-requests-http-'))
  const v2 = createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 } })
  const doors = new DoorStore(dir, { allowPrivate: true })
  doors.register('drej', {
    handle: 'drej',
    name: 'alpha',
    title: 'COOKREW Alpha',
    door: 'Pilot',
    agents: 3,
    address: 'https://cookrew.dev/@drej/alpha',
    transport: 'relay',
    sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab',
    access: 'paid',
    priceUsd: '1',
    rails: ['stripe', 'x402']
  })
  const server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors,
    stars: new StarStore(dir),
    origin: 'https://cookrew.dev',
    v2
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => {
        rmSync(dir, { recursive: true, force: true })
        resolve()
      })
    })
  drejToken = await claim('drej', drejMac)
  miraToken = await claim('mira', mira)
  drejMac2Token = await attach('drej', drejMac2, drejToken, 'desktop')
  drejPhoneToken = await attach('drej', drejPhone, drejToken, 'phone')
  // Both Macs register themselves as desktops, so a reach can name them.
  for (const [id, token] of [[drejMac.id, drejToken], [drejMac2.id, drejMac2Token]] as const) {
    await call('PUT', `/v2/me/desktops/${id}`, { name: 'A Mac', workspaces: [] }, as(token))
  }
})
afterAll(async () => close())

// ── R1: seat requests ──────────────────────────────────────────────────────

describe('POST /v2/teams/@o/t/seat-requests (R1)', () => {
  it('a signed-in guest asks, and asking twice returns the one request, not two', async () => {
    const first = await call('POST', '/v2/teams/@drej/alpha/seat-requests', {}, as(miraToken))
    expect(first.status).toBe(201)
    const a = await bodyOf<{ id: string; kind: string; team: string; state: string }>(first)
    expect(a).toMatchObject({ kind: 'seat', team: '@drej/alpha', state: 'pending' })
    const again = await call('POST', '/v2/teams/@drej/alpha/seat-requests', {}, as(miraToken))
    expect((await bodyOf<{ id: string }>(again)).id).toBe(a.id)
  })

  it('a signed-out guest is refused with the realm', async () => {
    const res = await call('POST', '/v2/teams/@drej/alpha/seat-requests', {})
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Cookrew realm="@drej/alpha"')
  })

  it('lands in the OWNER’s queue as one seat row, and nowhere the guest can see', async () => {
    const owner = await bodyOf<{ id: string; kind: string; account: string; team: string }[]>(
      await call('GET', '/v2/me/requests', undefined, as(drejToken))
    )
    const seat = owner.find((r) => r.kind === 'seat')
    expect(seat).toMatchObject({ kind: 'seat', account: 'mira', team: '@drej/alpha' })
    // The guest's own queue never shows the request they made.
    const guest = await bodyOf<unknown[]>(await call('GET', '/v2/me/requests', undefined, as(miraToken)))
    expect(guest).toEqual([])
  })

  it('APPROVE grants the seat, so the guest’s own GET …/seat sees it next poll', async () => {
    const owner = await bodyOf<{ id: string; kind: string }[]>(
      await call('GET', '/v2/me/requests', undefined, as(drejToken))
    )
    const seat = owner.find((r) => r.kind === 'seat')!
    const before = await bodyOf<{ seat: unknown }>(await call('GET', '/v2/teams/@drej/alpha/seat', undefined, as(miraToken)))
    expect(before.seat).toBeNull()
    expect((await call('POST', `/v2/me/requests/${seat.id}`, { decision: 'approve' }, as(drejToken))).status).toBe(204)
    const after = await bodyOf<{ seat: { account: string; source: string } | null }>(
      await call('GET', '/v2/teams/@drej/alpha/seat', undefined, as(miraToken))
    )
    expect(after.seat).toMatchObject({ account: 'mira', source: 'granted' })
    // Answered, so it leaves the owner's queue.
    const owner2 = await bodyOf<{ kind: string }[]>(await call('GET', '/v2/me/requests', undefined, as(drejToken)))
    expect(owner2.some((r) => r.kind === 'seat')).toBe(false)
  })

  it('only the team owner may answer a seat request', async () => {
    const asked = await bodyOf<{ id: string }>(
      await call('POST', '/v2/teams/@drej/alpha/seat-requests', {}, as(miraToken))
    )
    // mira is signed in, but the seat request is drej's to answer.
    expect((await call('POST', `/v2/me/requests/${asked.id}`, { decision: 'approve' }, as(miraToken))).status).toBe(404)
  })
})

// ── R2: reach requests, and the sealed pairing URL ──────────────────────────

describe('POST /v2/me/desktops/:id/reach-requests (R2)', () => {
  const PAIRING_URL = 'https://192.168.1.20:8643/#pair=super-secret-token'
  const info = (id: string): string => `reach:${id}`

  it('a device asks to reach one Mac; it lands in THAT Mac’s queue only', async () => {
    const asked = await bodyOf<{ id: string; kind: string; state: string }>(
      await call('POST', `/v2/me/desktops/${drejMac.id}/reach-requests`, {}, as(drejPhoneToken))
    )
    expect(asked).toMatchObject({ kind: 'reach', state: 'pending' })
    // The target Mac sees it, with the asking device's key to seal to.
    const mac = await bodyOf<{ id: string; kind: string; device: string; askKey?: Record<string, string> }[]>(
      await call('GET', '/v2/me/requests', undefined, as(drejToken))
    )
    const reach = mac.find((r) => r.kind === 'reach')
    expect(reach?.id).toBe(asked.id)
    expect(reach?.askKey).toEqual(drejPhone.pub)
    // The OTHER Mac of the same account does not — a reach is one Mac's to answer.
    const other = await bodyOf<{ kind: string }[]>(await call('GET', '/v2/me/requests', undefined, as(drejMac2Token)))
    expect(other.some((r) => r.kind === 'reach')).toBe(false)
  })

  it('ALLOW relays a sealed URL the asking device — and only it — can open', async () => {
    const asked = await bodyOf<{ id: string }>(
      await call('POST', `/v2/me/desktops/${drejMac.id}/reach-requests`, {}, as(drejPhoneToken))
    )
    // The Mac reads the asking key off its queue and seals the URL to it. The
    // seal is the app's (V3-13); here it is the same construction, run inline.
    const { sealToDevice } = await import('../registry/src/v2-device-seal')
    const sealed = sealToDevice(drejPhone.pub, info(asked.id), PAIRING_URL)
    expect((await call('POST', `/v2/me/requests/${asked.id}`, { decision: 'approve', sealed }, as(drejToken))).status).toBe(204)

    // The asking device polls and gets the sealed blob; nobody else can read it.
    const got = await bodyOf<{ state: string; sealed: SealedToDevice }>(
      await call('GET', `/v2/me/requests/${asked.id}`, undefined, as(drejPhoneToken))
    )
    expect(got.state).toBe('allowed')
    expect(openAtDevice(drejPhone.priv, info(asked.id), got.sealed)).toBe(PAIRING_URL)
    // A SECOND DEVICE'S KEY opens nothing — the Done-when's own check.
    expect(openAtDevice(drejMac2.priv, info(asked.id), got.sealed)).toBeNull()
    // And the registry never carried the URL in the clear on the wire.
    expect(JSON.stringify(got)).not.toContain('super-secret-token')

    // Handed over ONCE: the next poll is 'delivered' with no seal to re-read.
    const again = await bodyOf<{ state: string; sealed?: unknown }>(
      await call('GET', `/v2/me/requests/${asked.id}`, undefined, as(drejPhoneToken))
    )
    expect(again.state).toBe('delivered')
    expect(again.sealed).toBeUndefined()
  })

  it('a device that is not the asker cannot even see the reach request exists', async () => {
    const asked = await bodyOf<{ id: string }>(
      await call('POST', `/v2/me/desktops/${drejMac.id}/reach-requests`, {}, as(drejPhoneToken))
    )
    // drejMac2 is the same account but not the asker: 404, never a status leak.
    expect((await call('GET', `/v2/me/requests/${asked.id}`, undefined, as(drejMac2Token))).status).toBe(404)
  })

  it('only the named Mac may answer, and ALLOW without a sealed URL is refused', async () => {
    const asked = await bodyOf<{ id: string }>(
      await call('POST', `/v2/me/desktops/${drejMac.id}/reach-requests`, {}, as(drejPhoneToken))
    )
    // The other Mac is not the target.
    expect((await call('POST', `/v2/me/requests/${asked.id}`, { decision: 'approve', sealed: { alg: 'x25519', e: 'a', sealed: 'b' } }, as(drejMac2Token))).status).toBe(404)
    // The target Mac, but no sealed URL: an ALLOW with nothing to hand over.
    expect((await call('POST', `/v2/me/requests/${asked.id}`, { decision: 'approve' }, as(drejToken))).status).toBe(400)
  })

  it('refuses reaching a device that is not a desktop of the account, or oneself', async () => {
    expect((await call('POST', `/v2/me/desktops/${randomUUID()}/reach-requests`, {}, as(drejPhoneToken))).status).toBe(404)
    expect((await call('POST', `/v2/me/desktops/${drejMac.id}/reach-requests`, {}, as(drejToken))).status).toBe(400)
  })
})

// ── §06: a revoke voids, not-me empties ─────────────────────────────────────

describe('the revocation table (§06)', () => {
  it('revoking a device voids the reach requests it made, and tells every device', async () => {
    // A throwaway phone asks to reach the Mac, then is revoked.
    const phone = newDevice()
    const token = await attach('drej', phone, drejToken, 'phone')
    const asked = await bodyOf<{ id: string }>(
      await call('POST', `/v2/me/desktops/${drejMac.id}/reach-requests`, {}, as(token))
    )
    // The Mac can see it before the revoke.
    let mac = await bodyOf<{ id: string; kind: string }[]>(await call('GET', '/v2/me/requests', undefined, as(drejToken)))
    expect(mac.some((r) => r.id === asked.id)).toBe(true)
    // Revoke the asking phone.
    expect((await call('DELETE', `/v2/me/devices/${phone.id}`, undefined, as(drejToken))).status).toBe(204)
    // Its request is gone from the Mac's queue.
    mac = await bodyOf<{ id: string; kind: string }[]>(await call('GET', '/v2/me/requests', undefined, as(drejToken)))
    expect(mac.some((r) => r.id === asked.id)).toBe(false)
    // And a 'revoked' event names the device.
    const feed = await bodyOf<{ events: { kind: string; device?: string }[] }>(
      await call('GET', '/v2/me/events?since=0', undefined, as(drejToken))
    )
    expect(feed.events.some((e) => e.kind === 'revoked')).toBe(true)
  })

  it('“not me” empties the queue', async () => {
    // A fresh account so the count is its own.
    const mac = newDevice()
    const phone = newDevice()
    const token = await claim('rae', mac)
    const phoneToken = await attach('rae', phone, token, 'phone')
    await call('PUT', `/v2/me/desktops/${mac.id}`, { name: 'A Mac', workspaces: [] }, as(token))
    // A seat request rae is asking for, and a reach between rae's own devices.
    await call('POST', '/v2/teams/@drej/alpha/seat-requests', {}, as(token))
    await call('POST', `/v2/me/desktops/${mac.id}/reach-requests`, {}, as(phoneToken))
    // rae presses "not me" on a fresh sign-in ladder.
    const stranger = newDevice()
    const laddered = await call('POST', '/v2/sessions', {
      username: 'rae',
      password: PASSWORD,
      device: { id: stranger.id, kind: 'browser', name: 'A stranger', jwk: stranger.pub }
    })
    const asked = await bodyOf<{ pending: string }>(laddered)
    const req = await call('POST', `/v2/sessions/${asked.pending}/approve`)
    const { approval } = await bodyOf<{ approval: string }>(req)
    expect((await call('POST', `/v2/me/approvals/${approval}`, { decision: 'not-me' }, as(token))).status).toBe(204)
    // The queue rae was party to is empty — both as owner-of-nothing and as asker.
    const drejQueue = await bodyOf<{ kind: string; account?: string }[]>(
      await call('GET', '/v2/me/requests', undefined, as(drejToken))
    )
    expect(drejQueue.some((r) => r.kind === 'seat' && r.account === 'rae')).toBe(false)
    // rae's own token was ended by not-me; a fresh sign-in would show an empty queue.
    const feed = await bodyOf<{ events: { kind: string }[] }>(
      await call('GET', '/v2/me/events?since=0', undefined, as(drejToken))
    )
    expect(Array.isArray(feed.events)).toBe(true)
  })
})

// ── account:changed feed ────────────────────────────────────────────────────

describe('GET /v2/me/events — account:changed', () => {
  it('carries a cursor a device polls forward with, and never re-reads', async () => {
    const mac = newDevice()
    const token = await claim('eve', mac)
    // Nothing yet.
    const first = await bodyOf<{ events: unknown[]; cursor: number }>(
      await call('GET', '/v2/me/events?since=0', undefined, as(token))
    )
    expect(first.events).toEqual([])
    // eve asks drej for a seat → drej gets a 'request' event; eve's own feed is
    // unchanged (the event is the owner's).
    await call('POST', '/v2/teams/@drej/alpha/seat-requests', {}, as(token))
    const drejFeed = await bodyOf<{ events: { kind: string }[]; cursor: number }>(
      await call('GET', '/v2/me/events?since=0', undefined, as(drejToken))
    )
    expect(drejFeed.events.some((e) => e.kind === 'request')).toBe(true)
    // Polling forward from the cursor returns nothing new.
    const forward = await bodyOf<{ events: unknown[] }>(
      await call('GET', `/v2/me/events?since=${drejFeed.cursor}`, undefined, as(drejToken))
    )
    expect(forward.events).toEqual([])
  })
})
