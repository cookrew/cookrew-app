import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2, type V2Identity } from '../registry/src/v2-routes'
import { canonicalJson, helloMessage, reachHostKind } from '../registry/src/v2-reach'

/**
 * PHASE 2 — THE REACH CARD, THE OPEN TOKEN, AND HELLO.
 *
 * Three questions this file answers, because getting any of them wrong is a
 * different kind of wrong:
 *
 *   Is the card THIS desktop's?  A signature over a canonical string, checked
 *   against the key the account already holds for that device. Nothing else
 *   may write a machine's addresses.
 *
 *   Is the address one this may name?  Private, tailnet or .local only. A
 *   reach card naming a public host would turn the directory into a way to
 *   make signed-in browsers fetch arbitrary origins.
 *
 *   Who may read it?  Devices of the same account, and nobody else. The
 *   public profile must never carry it.
 */

const PASSWORD = 'correct horse battery staple'
const CERT = 'a'.repeat(64)

const key = () => {
  const pair = generateKeyPairSync('ed25519')
  return { pair, jwk: pair.publicKey.export({ format: 'jwk' }) as Record<string, string> }
}

interface Up {
  origin: string
  v2: V2Identity
  close: () => Promise<void>
}

async function up(): Promise<Up> {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-reach-'))
  const v2 = createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, helloPerMinute: 60 } })
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    v2,
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

const api = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${site.origin}${path}`, init)

const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})

/** An account whose first device is a desktop with a real Ed25519 key. */
async function claim(username: string): Promise<{
  token: string
  deviceId: string
  pair: ReturnType<typeof key>['pair']
}> {
  const { pair, jwk } = key()
  const deviceId = randomUUID()
  const res = await api('/v2/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: PASSWORD,
      device: { id: deviceId, kind: 'desktop', name: 'MacBook Pro', jwk }
    })
  })
  const body = (await res.json()) as { session: { token: string } }
  return { token: body.session.token, deviceId, pair }
}

interface Card {
  lan: { url: string; certFp: string }[]
  tailnet: { url: string; certFp: string } | null
  relay: boolean
  at: string
}

const card = (over: Partial<Card> = {}): Card => ({
  lan: [{ url: 'https://192.168.1.24:8643', certFp: CERT }],
  tailnet: { url: 'https://mac.tail1234.ts.net:8643', certFp: CERT },
  relay: true,
  at: new Date().toISOString(),
  ...over
})

const signCard = (pair: ReturnType<typeof key>['pair'], deviceId: string, reach: Card): string =>
  sign(
    null,
    Buffer.from(canonicalJson({ deviceId, ...reach }), 'utf8'),
    pair.privateKey
  ).toString('base64url')

async function publish(
  who: { token: string; deviceId: string; pair: ReturnType<typeof key>['pair'] },
  reach: Card = card(),
  sig?: string
): Promise<Response> {
  return api(`/v2/me/desktops/${who.deviceId}`, {
    method: 'PUT',
    headers: bearer(who.token),
    body: JSON.stringify({
      name: 'MacBook Pro',
      workspaces: [{ id: 'w1', name: 'Cookrew Dev' }],
      reach,
      sig: sig ?? signCard(who.pair, who.deviceId, reach)
    })
  })
}

beforeAll(async () => {
  site = await up()
})
afterAll(async () => {
  await site.close()
})

describe('canonical JSON', () => {
  it('sorts keys recursively and writes no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,1]},"b":1}')
  })

  it('keeps array order, which is the one order that carries meaning', () => {
    expect(canonicalJson([{ b: 2, a: 1 }, null, true])).toBe('[{"a":1,"b":2},null,true]')
  })

  it('is the same string whichever order the sender built the object in', () => {
    const one = canonicalJson({ deviceId: 'd', lan: [], tailnet: null, relay: false, at: 'z' })
    const two = canonicalJson({ at: 'z', relay: false, tailnet: null, lan: [], deviceId: 'd' })
    expect(one).toBe(two)
    expect(one).toBe('{"at":"z","deviceId":"d","lan":[],"relay":false,"tailnet":null}')
  })
})

describe('which hosts a reach card may name', () => {
  it('takes private IPv4, .local, 100.64/10 and *.ts.net', () => {
    expect(reachHostKind('https://192.168.1.24:8643')).toBe('lan')
    expect(reachHostKind('https://10.0.0.4:8643')).toBe('lan')
    expect(reachHostKind('https://172.20.3.9:8643')).toBe('lan')
    expect(reachHostKind('https://drej-mac.local:8643')).toBe('lan')
    expect(reachHostKind('https://[fd7a:115c::1]:8643')).toBe('lan')
    expect(reachHostKind('https://100.101.102.103:8643')).toBe('tailnet')
    expect(reachHostKind('https://mac.tail1234.ts.net:8643')).toBe('tailnet')
  })

  it('refuses a public host, a plain-text scheme and anything past the origin', () => {
    expect(reachHostKind('https://cookrew.dev')).toBeNull()
    expect(reachHostKind('https://8.8.8.8:8643')).toBeNull()
    expect(reachHostKind('https://172.32.0.1:8643')).toBeNull()
    expect(reachHostKind('http://192.168.1.24:8643')).toBeNull()
    expect(reachHostKind('https://192.168.1.24:8643/canvas')).toBeNull()
    expect(reachHostKind('https://user:pw@192.168.1.24:8643')).toBeNull()
    expect(reachHostKind('not a url')).toBeNull()
  })
})

describe('publishing a reach card', () => {
  it('takes a card this desktop signed', async () => {
    const who = await claim('reachone')
    expect((await publish(who)).status).toBe(204)
    const listed = (await (await api('/v2/me/desktops', { headers: bearer(who.token) })).json()) as {
      deviceId: string
      reach: { relay: boolean; lan: { url: string }[]; sig: string }
    }[]
    expect(listed).toHaveLength(1)
    expect(listed[0].deviceId).toBe(who.deviceId)
    expect(listed[0].reach.lan[0].url).toBe('https://192.168.1.24:8643')
    expect(listed[0].reach.relay).toBe(true)
  })

  it('refuses a card signed by another key', async () => {
    const who = await claim('reachtwo')
    const stranger = key()
    const reach = card()
    const sig = sign(null, Buffer.from(canonicalJson({ deviceId: who.deviceId, ...reach }), 'utf8'), stranger.pair.privateKey)
    const res = await publish(who, reach, sig.toString('base64url'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('bad_reach')
  })

  it('refuses a card whose signature covers a different device id', async () => {
    const who = await claim('reachthree')
    const reach = card()
    const res = await publish(who, reach, signCard(who.pair, randomUUID(), reach))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('bad_reach')
  })

  it('refuses a public host, a short fingerprint and more than eight LAN entries', async () => {
    const who = await claim('reachfour')
    const publicHost = card({ lan: [{ url: 'https://cookrew.dev', certFp: CERT }] })
    expect((await publish(who, publicHost)).status).toBe(400)
    const shortFp = card({ lan: [{ url: 'https://192.168.1.24:8643', certFp: 'abc' }] })
    expect((await publish(who, shortFp)).status).toBe(400)
    const many = card({
      lan: Array.from({ length: 9 }, (_, i) => ({ url: `https://192.168.1.${i}:8643`, certFp: CERT }))
    })
    expect((await publish(who, many)).status).toBe(400)
  })

  it('takes a card with no tailnet and no relay', async () => {
    const who = await claim('reachfive')
    const alone = card({ tailnet: null, relay: false })
    expect((await publish(who, alone)).status).toBe(204)
    const listed = (await (await api('/v2/me/desktops', { headers: bearer(who.token) })).json()) as {
      reach: { tailnet: unknown; relay: boolean }
    }[]
    expect(listed[0].reach.tailnet).toBeNull()
    expect(listed[0].reach.relay).toBe(false)
  })

  it('lets a desktop keep its workspaces without republishing its reach', async () => {
    const who = await claim('reachsix')
    await publish(who)
    const res = await api(`/v2/me/desktops/${who.deviceId}`, {
      method: 'PUT',
      headers: bearer(who.token),
      body: JSON.stringify({ name: 'MacBook Pro', workspaces: [] })
    })
    expect(res.status).toBe(204)
    const listed = (await (await api('/v2/me/desktops', { headers: bearer(who.token) })).json()) as {
      reach: { lan: unknown[] } | null
    }[]
    expect(listed[0].reach?.lan).toHaveLength(1)
  })
})

describe('who may read a reach card', () => {
  it('never puts it on the public profile', async () => {
    const who = await claim('reachseven')
    await publish(who)
    const profile = await (await api('/v2/accounts/reachseven')).json()
    expect(JSON.stringify(profile)).not.toContain('192.168')
    expect(profile.reach).toBeUndefined()
    expect(profile.desktops).toBeUndefined()
  })

  it('refuses the list to a caller with no session', async () => {
    const res = await api('/v2/me/desktops')
    expect(res.status).toBe(401)
    expect((await res.json()).message).toBe('Sign in to see this.')
  })

  it('shows an account only its own desktops', async () => {
    const mine = await claim('reacheight')
    const theirs = await claim('reachnine')
    await publish(mine)
    await publish(theirs)
    const listed = (await (await api('/v2/me/desktops', { headers: bearer(mine.token) })).json()) as {
      deviceId: string
    }[]
    expect(listed.map((d) => d.deviceId)).toEqual([mine.deviceId])
  })
})

/**
 * REACH v2.1 — THE OPEN TOKEN IS GONE.
 *
 * `POST /v2/me/desktops/:id/open` minted a canvas token for the
 * `?open=&key=&device=` admission. The relay prefix is already gated by the
 * account session and the Mac admits by the pairing token it prints, so the
 * route is not "unused", it is retired: it must not answer at all, to anyone.
 */
describe('the retired open route', () => {
  it('is a 404 for the owner of the desktop it named', async () => {
    const who = await claim('opentoken')
    await publish(who)
    const res = await api(`/v2/me/desktops/${who.deviceId}/open`, { method: 'POST', headers: bearer(who.token) })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('not_found')
  })

  it('is a 404 for a desktop that does not exist, and a 401 with no session', async () => {
    const who = await claim('openmissing')
    expect((await api(`/v2/me/desktops/${randomUUID()}/open`, { method: 'POST', headers: bearer(who.token) })).status)
      .toBe(404)
    expect((await api(`/v2/me/desktops/${randomUUID()}/open`, { method: 'POST' })).status).toBe(401)
  })

  it('answers nothing that could be spent at a Mac', async () => {
    const who = await claim('opennothing')
    await publish(who)
    const body = (await (
      await api(`/v2/me/desktops/${who.deviceId}/open`, { method: 'POST', headers: bearer(who.token) })
    ).json()) as Record<string, unknown>
    expect(body.token).toBeUndefined()
  })
})

describe('verifying a hello', () => {
  const hello = (deviceId: string, nonce: string, pair: ReturnType<typeof key>['pair']): string =>
    sign(null, Buffer.from(helloMessage(deviceId, nonce), 'utf8'), pair.privateKey).toString('base64url')

  it('says ok for a hello the desktop signed', async () => {
    const who = await claim('helloone')
    const nonce = randomBytes(16).toString('base64url')
    const res = await api('/v2/verify-hello', {
      method: 'POST',
      headers: bearer(who.token),
      body: JSON.stringify({ deviceId: who.deviceId, nonce, sig: hello(who.deviceId, nonce, who.pair) })
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('says no for another key, another nonce, a short nonce and an unknown device', async () => {
    const who = await claim('hellotwo')
    const nonce = randomBytes(16).toString('base64url')
    const ask = (body: unknown): Promise<Response> =>
      api('/v2/verify-hello', { method: 'POST', headers: bearer(who.token), body: JSON.stringify(body) })

    const stranger = key()
    const wrongKey = sign(null, Buffer.from(helloMessage(who.deviceId, nonce), 'utf8'), stranger.pair.privateKey)
    expect((await (await ask({ deviceId: who.deviceId, nonce, sig: wrongKey.toString('base64url') })).json()).ok).toBe(
      false
    )
    const other = randomBytes(16).toString('base64url')
    expect(
      (await (await ask({ deviceId: who.deviceId, nonce: other, sig: hello(who.deviceId, nonce, who.pair) })).json())
        .ok
    ).toBe(false)
    const short = randomBytes(8).toString('base64url')
    expect(
      (await (await ask({ deviceId: who.deviceId, nonce: short, sig: hello(who.deviceId, short, who.pair) })).json()).ok
    ).toBe(false)
    const unknown = randomUUID()
    expect((await (await ask({ deviceId: unknown, nonce, sig: hello(unknown, nonce, who.pair) })).json()).ok).toBe(false)
  })

  it('refuses a caller with no session', async () => {
    const res = await api('/v2/verify-hello', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: randomUUID(), nonce: randomBytes(16).toString('base64url'), sig: 'x' })
    })
    expect(res.status).toBe(401)
  })

  it('is limited to sixty a minute from one address', async () => {
    const who = await claim('hellorate')
    const nonce = randomBytes(16).toString('base64url')
    const body = JSON.stringify({ deviceId: who.deviceId, nonce, sig: hello(who.deviceId, nonce, who.pair) })
    let limited = 0
    for (let i = 0; i < 70; i++) {
      const res = await api('/v2/verify-hello', { method: 'POST', headers: bearer(who.token), body })
      if (res.status === 429) limited++
      await res.arrayBuffer()
    }
    expect(limited).toBeGreaterThan(0)
  })
})
