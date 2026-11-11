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
 * What is listed is a sign-in waiting for a nod, answered at the approvals
 * route with the number; and the feed every device catches up on.
 *
 * TWO OTHER KINDS ARE GONE (0.6.0): a device asking one Mac for Wi-Fi, and a
 * guest asking a team's owner for a seat. Each one's route answers as any
 * route the registry never had, and nothing it once opened can be listed,
 * polled or answered.
 *
 * A GUEST IS STILL SEATED, the two ways that were never a request, and both
 * are proved next door rather than again here: the owner grants by username
 * (tests/registry-v2-seats-http.test.ts, "grants a seat by username…" and the
 * app's half in tests/door-seats.test.ts), and a seat bought at the door is
 * recorded (the same file's "records a bought seat with the rail that settled
 * it", tests/seat-settle.test.ts and tests/seat-purchase-stripe-e2e.test.ts).
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

// The cast, once: an owner with two Macs and a phone, and a guest with no seat.
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

// ── a guest asking for a seat: gone with the team's page (0.6.0) ────────────

const feedOf = async (token: string): Promise<{ kind: string; device?: string; address?: string }[]> =>
  (await bodyOf<{ events: { kind: string; device?: string; address?: string }[] }>(await call('GET', '/v2/me/events?since=0', undefined, as(token)))).events
const queueOf = async (token: string): Promise<{ id: string; kind: string }[]> =>
  bodyOf<{ id: string; kind: string }[]>(await call('GET', '/v2/me/requests', undefined, as(token)))
/** What an answer says, and the realm it names, so two answers can be held side by side. */
const answerOf = async (res: Response): Promise<{ status: number; body: string; realm: string | null }> => ({
  status: res.status,
  body: await res.text(),
  realm: res.headers.get('www-authenticate')
})

describe('POST /v2/teams/@o/t/seat-requests, which the registry no longer takes', () => {
  /** Who might ask: a guest with no seat, the team's owner, another device of the owner, and nobody. */
  const askers = (): readonly (string | undefined)[] => [miraToken, drejToken, drejPhoneToken, undefined]

  it('answers exactly as an unknown route under a team does, signed in and signed out', async () => {
    for (const token of askers()) {
      const headers = token === undefined ? {} : as(token)
      const asked = await answerOf(await call('POST', '/v2/teams/@drej/alpha/seat-requests', {}, headers))
      const never = await answerOf(await call('POST', '/v2/teams/@drej/alpha/no-such-thing', {}, headers))
      expect(asked).toEqual(never)
      expect(asked.status).toBe(token === undefined ? 401 : 404)
      // Signed out is told to sign in at this team, as every route under it says; signed in is told there is nothing here.
      expect(asked.realm).toBe(token === undefined ? 'Cookrew realm="@drej/alpha"' : null)
    }
    // And a team that does not exist is still the same nothing, with or without the word.
    expect(await answerOf(await call('POST', '/v2/teams/@nobody/nothing/seat-requests', {}, as(miraToken)))).toEqual(
      await answerOf(await call('POST', '/v2/teams/@nobody/nothing/no-such-thing', {}, as(miraToken)))
    )
  })

  it('queues nothing and announces nothing, however often it is asked', async () => {
    const before = { owner: await queueOf(drejToken), guest: await queueOf(miraToken), said: await feedOf(drejToken), heard: await feedOf(miraToken) }
    for (let i = 0; i < 30; i += 1) {
      // Not even a limiter stands in front of it: there is no route to limit.
      expect((await call('POST', '/v2/teams/@drej/alpha/seat-requests', {}, as(miraToken))).status).toBe(404)
    }
    expect(await queueOf(drejToken)).toEqual(before.owner)
    expect(await queueOf(drejMac2Token)).toEqual(before.owner)
    expect(await queueOf(miraToken)).toEqual(before.guest)
    // The owner's feed is the one channel that tells them about their account: a stranger cannot write to it.
    expect(await feedOf(drejToken)).toEqual(before.said)
    expect(await feedOf(miraToken)).toEqual(before.heard)
    expect((await queueOf(drejToken)).every((row) => row.kind === 'join')).toBe(true)
  })

  it('seats nobody: the asker holds what they held, which GET …/seat still says', async () => {
    await call('POST', '/v2/teams/@drej/alpha/seat-requests', {}, as(miraToken))
    const mine = await call('GET', '/v2/teams/@drej/alpha/seat', undefined, as(miraToken))
    expect(mine.status).toBe(200)
    // The read that stays: whether this account HOLDS a seat, and the team's terms beside it.
    expect(await bodyOf<{ seat: unknown; team: { name: string; access: string } }>(mine)).toMatchObject({
      seat: null,
      team: { name: '@drej/alpha', access: 'paid' }
    })
    expect((await bodyOf<{ seats: unknown[] }>(await call('GET', '/v2/me/seats', undefined, as(miraToken)))).seats).toEqual([])
  })

  it('has no answer route either: POST /v2/me/requests/:id is as unknown as any other', async () => {
    const id = randomUUID()
    for (const token of [drejToken, miraToken, undefined]) {
      const headers = token === undefined ? {} : as(token)
      for (const body of [{ decision: 'approve' }, { decision: 'decline' }, {}]) {
        const answered = await answerOf(await call('POST', `/v2/me/requests/${id}`, body, headers))
        const never = await answerOf(await call('POST', `/v2/me/no-such-thing/${id}`, body, headers))
        expect(answered).toEqual(never)
        expect(answered.status).toBe(token === undefined ? 401 : 404)
      }
    }
  })
})

// ── a phone asking for Wi-Fi: gone with the relay's page (0.6.0) ────────────

describe('POST /v2/me/desktops/:id/reach-requests, which the registry no longer takes', () => {
  /** A route under /v2/me this registry has never had: how it answers one. */
  const unknown = (id: string, token?: string): Promise<Response> =>
    call('POST', `/v2/me/desktops/${id}/no-such-thing`, {}, token === undefined ? {} : as(token))

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
    const before = { mac: await queueOf(drejToken), mac2: await queueOf(drejMac2Token), phone: await queueOf(drejPhoneToken), said: await feedOf(drejToken) }
    expect((await call('POST', `/v2/me/desktops/${drejMac.id}/reach-requests`, {}, as(drejPhoneToken))).status).toBe(404)
    expect(await queueOf(drejToken)).toEqual(before.mac)
    expect(await queueOf(drejMac2Token)).toEqual(before.mac2)
    expect(await queueOf(drejPhoneToken)).toEqual(before.phone)
    expect(await feedOf(drejToken)).toEqual(before.said)
    for (const token of [drejToken, drejMac2Token, drejPhoneToken]) {
      expect((await queueOf(token)).every((row) => row.kind === 'join')).toBe(true)
    }
  })

  it('has no answer to poll for: a request’s id is not a page of its own', async () => {
    for (const token of [drejToken, drejPhoneToken, miraToken]) {
      const res = await call('GET', `/v2/me/requests/${randomUUID()}`, undefined, as(token))
      expect(res.status).toBe(404)
      expect(await bodyOf<{ error: string }>(res)).toMatchObject({ error: 'not_found' })
    }
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

// ── §06: a revoke is told, not-me is answered ───────────────────────────────

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

  it('“not me” is answered with the account’s own proof, and the stranger is never let in', async () => {
    // A fresh account so the count is its own.
    const mac = newDevice()
    const token = await claim('rae', mac)
    await call('PUT', `/v2/me/desktops/${mac.id}`, { name: 'A Mac', workspaces: [] }, as(token))
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
    // It was in the queue, as a join row, until it was answered.
    expect((await queueOf(token)).map((row) => [row.id, row.kind])).toEqual([[approval, 'join']])
    expect(
      (await call('POST', `/v2/me/approvals/${approval}`, { decision: 'not-me', current: PASSWORD }, as(token)))
        .status
    ).toBe(204)
    // The sign-in it disowned gets no session.
    expect((await call('GET', `/v2/sessions/${asked.pending}`)).status).not.toBe(201)
    // Nobody else's queue or feed is touched by it.
    expect((await queueOf(drejToken)).some((row) => row.id === approval)).toBe(false)
    expect((await feedOf(drejToken)).some((event) => event.kind === 'not-me')).toBe(false)
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
    // Something happens to eve's own account: a phone joins and is taken off again.
    const phone = newDevice()
    await attach('eve', phone, token, 'phone')
    expect((await call('DELETE', `/v2/me/devices/${phone.id}`, { current: PASSWORD }, as(token))).status).toBe(204)
    const feed = await bodyOf<{ events: { kind: string }[]; cursor: number }>(
      await call('GET', '/v2/me/events?since=0', undefined, as(token))
    )
    expect(feed.events.some((e) => e.kind === 'revoked')).toBe(true)
    expect(feed.cursor).toBeGreaterThan(first.cursor)
    // Polling forward from the cursor returns nothing new.
    const forward = await bodyOf<{ events: unknown[] }>(
      await call('GET', `/v2/me/events?since=${feed.cursor}`, undefined, as(token))
    )
    expect(forward.events).toEqual([])
    // And it was eve's feed only: what happens to one account is told to that account.
    expect((await feedOf(miraToken)).some((e) => e.kind === 'revoked')).toBe(false)
  })
})
