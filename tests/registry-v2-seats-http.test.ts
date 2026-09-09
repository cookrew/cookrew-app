import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'

/**
 * SEATS OVER HTTP — the gate, as a stranger meets it.
 *
 * The store's rules are proved next door; this proves the SERVER: who may ask
 * each question, the codes, the sentences a person reads, and the one thing
 * the door on the other side depends on — a call token that names the seat it
 * was minted for.
 *
 * Gate order, from the architecture note: 401 sign in → 403 no seat → 402 buy
 * → open. The 402 is still the door's own; the registry answers the first two
 * and records what the third produced.
 */

const PASSWORD = 'correct horse battery staple'

const device = (name = 'Chrome on macOS') => ({
  id: randomUUID(),
  kind: 'browser' as const,
  name,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

let dir = ''
let origin = ''
let close: () => Promise<void> = async () => undefined

interface Who {
  username: string
  token: string
  deviceId: string
}
const people: Record<string, Who> = {}

const call = (
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Response> =>
  fetch(`${origin}${p}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  })

const as = (who: Who): Record<string, string> => ({ authorization: `Bearer ${who.token}` })

async function claim(username: string): Promise<Who> {
  const res = await call('POST', '/v2/accounts', { username, password: PASSWORD, device: device(username) })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { deviceId: string; session: { token: string } }
  return { username, token: body.session.token, deviceId: body.deviceId }
}

/** The claims inside a token, which is `base64url(json).signature`. */
const claimsOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'v2-seats-http-'))
  const v2 = createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
  const doors = new DoorStore(dir, { allowPrivate: true })
  const face = {
    handle: 'drej',
    door: 'Pilot',
    agents: 3,
    transport: 'relay' as const,
    sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab'
  }
  doors.register('drej', {
    ...face,
    name: 'alpha',
    title: 'COOKREW Alpha',
    address: 'https://cookrew.dev/@drej/alpha',
    access: 'paid',
    priceUsd: '1',
    rails: ['stripe', 'x402']
  })
  doors.register('drej', {
    ...face,
    name: 'open-house',
    title: 'Open House',
    address: 'https://cookrew.dev/@drej/open-house',
    access: 'account',
    rails: []
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
  people.drej = await claim('drej')
  people.mira = await claim('mira')
  people.lin = await claim('lin')
  people.stranger = await claim('stranger')
})

afterAll(async () => {
  await close()
})

describe('GET /v2/teams/@o/t/seat — what do I hold here', () => {
  it('refuses a signed-out reader with the sentence and a realm naming the team', async () => {
    const res = await call('GET', '/v2/teams/@drej/alpha/seat')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Cookrew realm="@drej/alpha"')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('unauthenticated')
    expect(body.message).toContain('A seat is yours, not a browser')
  })

  it('answers null and the team’s own terms for a signed-in stranger', async () => {
    const res = await call('GET', '/v2/teams/@drej/alpha/seat', undefined, as(people.stranger))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { seat: unknown; team: Record<string, unknown> }
    expect(body.seat).toBeNull()
    expect(body.team).toMatchObject({
      name: '@drej/alpha',
      access: 'paid',
      priceUsd: '1',
      rails: ['stripe', 'x402'],
      door: 'Pilot'
    })
  })

  it('is 404 for a team nobody is serving', async () => {
    const res = await call('GET', '/v2/teams/@drej/nothing/seat', undefined, as(people.mira))
    expect(res.status).toBe(404)
  })
})

describe('POST /v2/teams/@o/t/seats — the owner seats somebody', () => {
  it('is refused to anyone who is not the owner, in a sentence naming them', async () => {
    const res = await call('POST', '/v2/teams/@drej/alpha/seats', { username: 'lin' }, as(people.mira))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('not_owner')
    expect(body.message).toContain('@drej')
  })

  it('is refused to a reader with no session at all', async () => {
    expect((await call('POST', '/v2/teams/@drej/alpha/seats', { username: 'lin' })).status).toBe(401)
  })

  it('seats a known account and says who gave it', async () => {
    const res = await call('POST', '/v2/teams/@drej/alpha/seats', { username: '@Mira' }, as(people.drej))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { seat: Record<string, unknown> }
    expect(body.seat).toMatchObject({ account: 'mira', source: 'granted', by: 'drej', team: '@drej/alpha' })

    const mine = await call('GET', '/v2/teams/@drej/alpha/seat', undefined, as(people.mira))
    expect(((await mine.json()) as { seat: { id: string } }).seat.id).toBe(body.seat.id)
  })

  it('refuses a username no account has claimed', async () => {
    const res = await call('POST', '/v2/teams/@drej/alpha/seats', { username: 'nobody-here' }, as(people.drej))
    expect(res.status).toBe(404)
  })

  it('refuses a second seat for the same person', async () => {
    const res = await call('POST', '/v2/teams/@drej/alpha/seats', { username: 'mira' }, as(people.drej))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('already_seated')
  })

  it('refuses a cookie-carried write from another site', async () => {
    const res = await call(
      'POST',
      '/v2/teams/@drej/alpha/seats',
      { username: 'lin' },
      { cookie: `__Host-cr_session=${people.drej.token}`, origin: 'https://evil.example' }
    )
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('bad_origin')
  })
})

describe('POST /v2/teams/@o/t/seats/settle — the door reports a purchase', () => {
  it('records a bought seat with the rail that settled it', async () => {
    const res = await call(
      'POST',
      '/v2/teams/@drej/alpha/seats/settle',
      { username: 'lin', source: 'bought', by: 'stripe', receipt: 'cs_test_a1' },
      as(people.drej)
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { seat: Record<string, unknown> }
    expect(body.seat).toMatchObject({ account: 'lin', source: 'bought', by: 'stripe' })
    // The receipt is the owner's business, not the room's: it is not handed back.
    expect(body.seat.receipt).toBeUndefined()
  })

  it('is the owner’s report, not a caller’s claim', async () => {
    const res = await call(
      'POST',
      '/v2/teams/@drej/alpha/seats/settle',
      { username: 'stranger', source: 'bought', by: 'stripe', receipt: 'cs_test_b2' },
      as(people.stranger)
    )
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('not_owner')
  })

  it('refuses a rail or a receipt the door could not have produced', async () => {
    const bad = await call(
      'POST',
      '/v2/teams/@drej/alpha/seats/settle',
      { username: 'stranger', source: 'bought', by: 'cash', receipt: 'x' },
      as(people.drej)
    )
    expect(bad.status).toBe(400)
    const long = await call(
      'POST',
      '/v2/teams/@drej/alpha/seats/settle',
      { username: 'stranger', source: 'bought', by: 'x402', receipt: 'r'.repeat(513) },
      as(people.drej)
    )
    expect(long.status).toBe(400)
  })
})

describe('GET /v2/teams/@o/t/seats — the owner’s list', () => {
  it('names every seat, its holder and where it came from', async () => {
    const res = await call('GET', '/v2/teams/@drej/alpha/seats', undefined, as(people.drej))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { seats: { account: string; source: string; by: string }[] }
    expect(body.seats.map((s) => s.account).sort()).toEqual(['lin', 'mira'])
    expect(body.seats.find((s) => s.account === 'mira')).toMatchObject({ source: 'granted', by: 'drej' })
    expect(body.seats.find((s) => s.account === 'lin')).toMatchObject({ source: 'bought', by: 'stripe' })
  })

  it('is not readable by a seated guest — the list is the owner’s', async () => {
    const res = await call('GET', '/v2/teams/@drej/alpha/seats', undefined, as(people.mira))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('not_owner')
  })
})

describe('GET /v2/teams/@o/t/seated — who else is in the room', () => {
  it('names the other seated usernames to a seated guest', async () => {
    const res = await call('GET', '/v2/teams/@drej/alpha/seated', undefined, as(people.mira))
    expect(res.status).toBe(200)
    expect((await res.json()) as { usernames: string[] }).toEqual({ usernames: ['lin', 'mira'] })
  })

  it('answers the owner too', async () => {
    const res = await call('GET', '/v2/teams/@drej/alpha/seated', undefined, as(people.drej))
    expect(res.status).toBe(200)
  })

  it('tells a signed-in stranger they have no seat, not who is here', async () => {
    const res = await call('GET', '/v2/teams/@drej/alpha/seated', undefined, as(people.stranger))
    expect(res.status).toBe(403)
    const text = await res.text()
    const body = JSON.parse(text) as { error: string; message: string }
    expect(body.error).toBe('no_seat')
    expect(body.message).toContain('@drej')
    // Not who is in the room, in any part of the answer.
    expect(text).not.toContain('mira')
  })

  it('tells a signed-out reader to sign in first', async () => {
    const res = await call('GET', '/v2/teams/@drej/alpha/seated')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Cookrew realm="@drej/alpha"')
  })
})

describe('POST /v2/teams/@o/t/call-token — the word the door verifies', () => {
  it('mints a token for this one door, naming the seat it was minted for', async () => {
    const res = await call('POST', '/v2/teams/@drej/alpha/call-token', {}, as(people.mira))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { token: string; exp: number; seat: string }
    const claims = claimsOf(body.token)
    expect(claims.scope).toBe('call')
    expect(claims.aud).toBe('@drej/alpha')
    expect(claims.sub).toBe('mira')
    expect(claims.dev).toBe(people.mira.deviceId)
    expect(claims.seat).toBe(body.seat)
    expect(typeof claims.seat).toBe('string')
    expect(body.exp).toBeGreaterThan(Date.now())
  })

  it('refuses a signed-in stranger with no seat, and offers the two ways to get one', async () => {
    const res = await call('POST', '/v2/teams/@drej/alpha/call-token', {}, as(people.stranger))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('no_seat')
    expect(body.message).toContain('ask @drej')
  })

  it('refuses a signed-out reader before it refuses the seat', async () => {
    const res = await call('POST', '/v2/teams/@drej/alpha/call-token', {})
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Cookrew realm="@drej/alpha"')
  })

  it('mints for the owner of the door, who never needs a seat at their own team', async () => {
    const res = await call('POST', '/v2/teams/@drej/alpha/call-token', {}, as(people.drej))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { token: string; seat: string | null }
    expect(body.seat).toBeNull()
    expect(claimsOf(body.token).seat).toBeUndefined()
  })

  it('mints for anyone signed in at a team that charges nothing — registering is the gate', async () => {
    const free = await call('POST', '/v2/teams/@drej/open-house/call-token', {}, as(people.stranger))
    expect(free.status).toBe(201)
    expect(claimsOf(((await free.json()) as { token: string }).token).aud).toBe('@drej/open-house')
    const out = await call('POST', '/v2/teams/@drej/open-house/call-token', {})
    expect(out.status).toBe(401)
  })

  it('stops minting the moment the owner ends the seat', async () => {
    const seats = (await (await call('GET', '/v2/teams/@drej/alpha/seats', undefined, as(people.drej))).json()) as {
      seats: { id: string; account: string }[]
    }
    const lin = seats.seats.find((s) => s.account === 'lin')
    if (!lin) throw new Error('lin has no seat')
    const ended = await call('DELETE', `/v2/teams/@drej/alpha/seats/${lin.id}`, undefined, as(people.drej))
    expect(ended.status).toBe(204)
    const after = await call('POST', '/v2/teams/@drej/alpha/call-token', {}, as(people.lin))
    expect(after.status).toBe(403)
    expect(((await after.json()) as { error: string }).error).toBe('no_seat')
  })
})

describe('DELETE /v2/teams/@o/t/seats/:id — ending one', () => {
  it('is the owner’s alone', async () => {
    const mine = (await (await call('GET', '/v2/teams/@drej/alpha/seat', undefined, as(people.mira))).json()) as {
      seat: { id: string }
    }
    const res = await call(`DELETE`, `/v2/teams/@drej/alpha/seats/${mine.seat.id}`, undefined, as(people.mira))
    expect(res.status).toBe(403)
    expect((await call('GET', '/v2/teams/@drej/alpha/seat', undefined, as(people.mira))).status).toBe(200)
  })

  it('answers 404 for a seat that is not there', async () => {
    const res = await call('DELETE', `/v2/teams/@drej/alpha/seats/${randomUUID()}`, undefined, as(people.drej))
    expect(res.status).toBe(404)
  })
})

describe('GET /v2/me/seats — everything I hold', () => {
  it('lists the caller’s own seats, active first, and never anyone else’s', async () => {
    const res = await call('GET', '/v2/me/seats', undefined, as(people.lin))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { seats: { team: string; account: string; endedAt?: number }[] }
    expect(body.seats).toHaveLength(1)
    expect(body.seats[0]).toMatchObject({ team: '@drej/alpha', account: 'lin' })
    expect(body.seats[0].endedAt).toBeGreaterThan(0)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('is a refusal, not an empty list, when nobody is signed in', async () => {
    expect((await call('GET', '/v2/me/seats')).status).toBe(401)
  })
})
