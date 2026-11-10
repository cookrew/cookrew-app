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

/**
 * IDENTITY v3 — THE ONE QUEUE, over HTTP (V3-11).
 *
 * The two kinds through the same list (a sign-in waiting for a nod, a guest
 * asking for a seat), the seat ruling's route, and the revocation table: a
 * revoke is told to every device, "not me" empties the queue.
 *
 * A THIRD KIND IS GONE (0.6.0): a device asking one Mac for Wi-Fi. Its route
 * answers as any route the registry never had, and nothing it once opened can
 * be listed, polled or answered.
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
  const v2 = createV2(dir, { secondStep: 'legacy', limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 } })
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
  // Both Macs register themselves as desktops of the account.
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

  /**
   * A STRANGER MUST NOT BE ABLE TO FLUSH THE OWNER'S FEED (H5).
   *
   * account:changed is the ONLY channel this design has for telling an owner
   * that something happened to their account — there is no email. Its tail is
   * bounded, so anything that can be appended at will is a way to push the
   * owner's real security events out of it: a device joining, a revoke, a
   * password change. That is a feed which stops working at exactly the moment
   * it matters, which is while somebody is attacking the account.
   *
   * Two halves, and the flood needs both to be closed:
   *   · the event follows the DEDUPE — one row per (team, account) already,
   *     and a request that opened no row is not a thing that happened;
   *   · the route is LIMITED, like every other route that writes.
   * And the tail itself now reserves room, so even a distributed ask cannot
   * evict what the owner has to see.
   */
  it('a stranger’s flood leaves the owner’s earlier events still readable', async () => {
    const flooder = newDevice()
    const flooderToken = await claim('flood', flooder)

    // The owner's real security events, from before the flood.
    const throwaway = newDevice()
    const throwawayToken = await attach('drej', throwaway, drejToken, 'phone')
    expect(throwawayToken.length).toBeGreaterThan(0)
    // Revoking another device is on the step-up list (C1), so the password is
    // proved again here. The threshold in front of the event is not the thing
    // this test measures — the feed underneath it is.
    expect(
      (await call('DELETE', `/v2/me/devices/${throwaway.id}`, { current: PASSWORD }, as(drejToken)))
        .status
    ).toBe(204)
    const before = await bodyOf<{ events: { kind: string }[] }>(
      await call('GET', '/v2/me/events?since=0', undefined, as(drejToken))
    )
    const revokedBefore = before.events.filter((e) => e.kind === 'revoked').length
    const askedBefore = before.events.filter((e) => e.kind === 'request').length
    expect(revokedBefore).toBeGreaterThan(0)

    // 120 asks from one account that never gets a seat.
    let created = 0
    let limited = 0
    const ids = new Set<string>()
    for (let i = 0; i < 120; i += 1) {
      const res = await call('POST', '/v2/teams/@drej/alpha/seat-requests', {}, as(flooderToken))
      if (res.status === 429) {
        limited += 1
        continue
      }
      expect(res.status).toBe(201)
      created += 1
      ids.add((await bodyOf<{ id: string }>(res)).id)
    }

    // The queue was always right: one row for one asker at one team.
    const queue = await bodyOf<{ kind: string; account?: string }[]>(
      await call('GET', '/v2/me/requests', undefined, as(drejToken))
    )
    expect(queue.filter((r) => r.kind === 'seat' && r.account === 'flood')).toHaveLength(1)
    expect(ids.size).toBe(1)
    // The route stops answering long before 120, like every sibling that writes.
    expect(limited).toBeGreaterThan(0)
    expect(created).toBeLessThan(120)

    // THE FEED IS THE POINT. One arrival is one event, and the owner's own
    // security events are all still there to be read.
    const after = await bodyOf<{ events: { kind: string; address?: string }[] }>(
      await call('GET', '/v2/me/events?since=0', undefined, as(drejToken))
    )
    expect(after.events.filter((e) => e.kind === 'revoked')).toHaveLength(revokedBefore)
    // EXACTLY ONE, whatever the limiter let through: the queue held one row
    // for this asker, so one thing happened. Counted as a difference so it
    // pins the dedupe on its own rather than on how many asks were refused.
    expect(after.events.filter((e) => e.kind === 'request').length).toBe(askedBefore + 1)
  })

  it('only the team owner may answer a seat request', async () => {
    const asked = await bodyOf<{ id: string }>(
      await call('POST', '/v2/teams/@drej/alpha/seat-requests', {}, as(miraToken))
    )
    // mira is signed in, but the seat request is drej's to answer.
    expect((await call('POST', `/v2/me/requests/${asked.id}`, { decision: 'approve' }, as(miraToken))).status).toBe(404)
  })
})

// ── a phone asking for Wi-Fi: gone with the relay's page (0.6.0) ────────────

describe('POST /v2/me/desktops/:id/reach-requests, which the registry no longer takes', () => {
  /** A route under /v2/me this registry has never had: how it answers one. */
  const unknown = (id: string, token?: string): Promise<Response> =>
    call('POST', `/v2/me/desktops/${id}/no-such-thing`, {}, token === undefined ? {} : as(token))
  const queueOf = async (token: string): Promise<{ id: string; kind: string }[]> =>
    bodyOf<{ id: string; kind: string }[]>(await call('GET', '/v2/me/requests', undefined, as(token)))
  const requestEvents = async (): Promise<number> =>
    (await bodyOf<{ events: { kind: string }[] }>(await call('GET', '/v2/me/events?since=0', undefined, as(drejToken)))).events.filter(
      (e) => e.kind === 'request'
    ).length

  it('answers as any unknown route does, whoever asks and whichever machine is named', async () => {
    const asks: readonly [string, string | undefined][] = [
      // A phone of the account naming one of its Macs: the ask that once opened a row.
      [drejMac.id, drejPhoneToken],
      // A Mac naming itself, a machine that is nobody's, and somebody else's account.
      [drejMac.id, drejToken],
      [randomUUID(), drejPhoneToken],
      [drejMac.id, miraToken],
      // And nobody at all.
      [drejMac.id, undefined]
    ]
    for (const [id, token] of asks) {
      const res = await call('POST', `/v2/me/desktops/${id}/reach-requests`, {}, token === undefined ? {} : as(token))
      const never = await unknown(id, token)
      expect(res.status).toBe(never.status)
      expect(await res.text()).toBe(await never.text())
      expect(res.status).toBe(token === undefined ? 401 : 404)
    }
  })

  it('opens nothing: no row in any device’s queue, and nothing said on the feed', async () => {
    const before = { mac: await queueOf(drejToken), mac2: await queueOf(drejMac2Token), phone: await queueOf(drejPhoneToken), said: await requestEvents() }
    expect((await call('POST', `/v2/me/desktops/${drejMac.id}/reach-requests`, {}, as(drejPhoneToken))).status).toBe(404)
    expect(await queueOf(drejToken)).toEqual(before.mac)
    expect(await queueOf(drejMac2Token)).toEqual(before.mac2)
    expect(await queueOf(drejPhoneToken)).toEqual(before.phone)
    expect(await requestEvents()).toBe(before.said)
    for (const token of [drejToken, drejMac2Token, drejPhoneToken]) {
      expect((await queueOf(token)).every((row) => row.kind === 'join' || row.kind === 'seat')).toBe(true)
    }
  })

  it('has no answer to poll for: a request’s id is not a page of its own', async () => {
    // A seat request is real, and it was never read here either: its answer is GET …/seat.
    const seat = await bodyOf<{ id: string }>(await call('POST', '/v2/teams/@drej/alpha/seat-requests', {}, as(miraToken)))
    for (const [id, token] of [[seat.id, miraToken], [seat.id, drejToken], [randomUUID(), drejPhoneToken]] as const) {
      const res = await call('GET', `/v2/me/requests/${id}`, undefined, as(token))
      expect(res.status).toBe(404)
      expect(await bodyOf<{ error: string }>(res)).toMatchObject({ error: 'not_found' })
    }
  })

  it('takes no sealed answer: the queue’s own route answers a seat and nothing else', async () => {
    const sealed = { alg: 'x25519', e: 'a', sealed: 'b' }
    expect((await call('POST', `/v2/me/requests/${randomUUID()}`, { decision: 'approve', sealed }, as(drejToken))).status).toBe(404)
    // A seat request is still answered there, by its owner, as before.
    const asked = await bodyOf<{ id: string }>(await call('POST', '/v2/teams/@drej/alpha/seat-requests', {}, as(miraToken)))
    expect((await call('POST', `/v2/me/requests/${asked.id}`, { decision: 'decline', sealed }, as(drejToken))).status).toBe(204)
  })

  it('leaves a sign-in waiting for a nod exactly where it was: listed as a join row, and answered', async () => {
    const browser = newDevice()
    const started = await call('POST', '/v2/sessions', {
      username: 'drej',
      password: PASSWORD,
      device: { id: browser.id, kind: 'browser', name: 'A new browser', jwk: browser.pub }
    })
    expect(started.status).toBe(401)
    const asked = await bodyOf<{ pending: string; match: string }>(started)
    const { approval } = await bodyOf<{ approval: string }>(await call('POST', `/v2/sessions/${asked.pending}/approve`))
    const row = (await bodyOf<{ id: string; kind: string; device?: string }[]>(await call('GET', '/v2/me/requests', undefined, as(drejToken)))).find(
      (r) => r.id === approval
    )
    expect(row).toMatchObject({ kind: 'join', device: 'A new browser' })
    // The wrong number is still refused, and the right one still lets the device in.
    const wrong = asked.match === '11' ? '12' : '11'
    expect((await call('POST', `/v2/me/approvals/${approval}`, { decision: 'approve', match: wrong }, as(drejToken))).status).toBe(400)
    expect((await call('POST', `/v2/me/approvals/${approval}`, { decision: 'approve', match: asked.match }, as(drejToken))).status).toBe(204)
    expect((await call('GET', `/v2/sessions/${asked.pending}`)).status).toBe(201)
    expect((await queueOf(drejToken)).some((r) => r.id === approval)).toBe(false)
  })
})

// ── §06: a revoke is told, not-me empties ───────────────────────────────────

describe('the revocation table (§06)', () => {
  it('revoking a device tells every device', async () => {
    const phone = newDevice()
    await attach('drej', phone, drejToken, 'phone')
    const said = async (): Promise<number> =>
      (await bodyOf<{ events: { kind: string }[] }>(await call('GET', '/v2/me/events?since=0', undefined, as(drejToken)))).events.filter(
        (e) => e.kind === 'revoked'
      ).length
    const before = await said()
    expect((await call('DELETE', `/v2/me/devices/${phone.id}`, { current: PASSWORD }, as(drejToken))).status).toBe(204)
    // A 'revoked' event names the device.
    const feed = await bodyOf<{ events: { kind: string; device?: string }[] }>(
      await call('GET', '/v2/me/events?since=0', undefined, as(drejToken))
    )
    expect(feed.events.some((e) => e.kind === 'revoked')).toBe(true)
    expect(await said()).toBe(before + 1)
    expect(feed.events.filter((e) => e.kind === 'revoked').at(-1)?.device).toBe("drej's phone")
  })

  it('“not me” empties the queue', async () => {
    // A fresh account so the count is its own.
    const mac = newDevice()
    const token = await claim('rae', mac)
    await call('PUT', `/v2/me/desktops/${mac.id}`, { name: 'A Mac', workspaces: [] }, as(token))
    // A seat request rae is asking for.
    await call('POST', '/v2/teams/@drej/alpha/seat-requests', {}, as(token))
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
    expect(
      (await call('POST', `/v2/me/approvals/${approval}`, { decision: 'not-me', current: PASSWORD }, as(token)))
        .status
    ).toBe(204)
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
