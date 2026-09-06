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
import { createV2 } from '../registry/src/v2-routes'
import { canonicalJson, helloMessage } from '../registry/src/v2-reach'
import {
  HELLO_SKEW_MS,
  helloMessageV2,
  originBelongsTo,
  verifyHelloClaim
} from '../registry/src/hello-verify'
import { HELLO_BURN_MAX, createHelloBurn, helloBurnTtlMs } from '../registry/src/hello-nonces'

/**
 * FRESHNESS AND SINGLE USE, AT THE ONE PARTY THAT HOLDS THE KEY.
 *
 * The registry is the only place that can say a hello is the Mac's, so it is
 * also the only place that can say it is the Mac's FOR THE FIRST TIME. Three
 * refusals live here and nowhere else — a clock too far out (`stale`), a pair
 * already spent (`replayed`), and an origin this desktop could not honestly
 * answer at (`wrong_origin`) — plus the old one, `bad_signature`.
 *
 * The fourth check, that the signed origin is the one the CLIENT dialled, is
 * not here on purpose: the registry was not on that connection. See
 * tests/plane-hello-origin.test.ts.
 */

const PASSWORD = 'correct horse battery staple'
const CERT = 'a'.repeat(64)
const ZONE = 'd.cookrew.dev'

const key = () => {
  const pair = generateKeyPairSync('ed25519')
  return { pair, jwk: pair.publicKey.export({ format: 'jwk' }) as Record<string, string> }
}

interface Up {
  origin: string
  close: () => Promise<void>
}

async function up(): Promise<Up> {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-hello2-'))
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2: createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, helloPerMinute: 1000 } })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
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
const api = (p: string, init: RequestInit = {}): Promise<Response> => fetch(`${site.origin}${p}`, init)
const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})

type Who = { token: string; deviceId: string; pair: ReturnType<typeof key>['pair'] }

async function claim(username: string): Promise<Who> {
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

const publish = async (who: Who): Promise<void> => {
  const reach = {
    lan: [{ url: 'https://192.168.1.24:8643', certFp: CERT }],
    tailnet: null,
    relay: true,
    at: new Date().toISOString()
  }
  await api(`/v2/me/desktops/${who.deviceId}`, {
    method: 'PUT',
    headers: bearer(who.token),
    body: JSON.stringify({
      name: 'MacBook Pro',
      workspaces: [{ id: 'w1', name: 'Cookrew Dev' }],
      reach,
      sig: sign(
        null,
        Buffer.from(canonicalJson({ deviceId: who.deviceId, ...reach }), 'utf8'),
        who.pair.privateKey
      ).toString('base64url')
    })
  })
}

const nameFor = (who: Who): string => `https://192-168-1-24.${who.deviceId}.${ZONE}:8643`

const signV2 = (who: Who, origin: string, issuedAtMs: number, nonce: string): string =>
  sign(
    null,
    Buffer.from(helloMessageV2(who.deviceId, origin, issuedAtMs, nonce), 'utf8'),
    who.pair.privateKey
  ).toString('base64url')

const askRaw = (who: Who, body: unknown): Promise<Response> =>
  api('/v2/verify-hello', { method: 'POST', headers: bearer(who.token), body: JSON.stringify(body) })

const ask = async (who: Who, body: unknown): Promise<{ ok?: boolean; reason?: string }> =>
  (await askRaw(who, body)).json() as Promise<{ ok?: boolean; reason?: string }>

const claimBody = (who: Who, over: Record<string, unknown> = {}): Record<string, unknown> => {
  const origin = nameFor(who)
  const issuedAtMs = Date.now()
  const nonce = randomBytes(16).toString('base64url')
  return {
    deviceId: who.deviceId,
    origin,
    issuedAtMs,
    nonce,
    sig: signV2(who, origin, issuedAtMs, nonce),
    ...over
  }
}

beforeAll(async () => {
  site = await up()
})
afterAll(async () => {
  await site.close()
})

describe('a version 2 hello at the registry', () => {
  it("says ok for a hello signed at a name under this desktop's own subdomain", async () => {
    const who = await claim('hellov2ok')
    expect(await ask(who, claimBody(who))).toEqual({ ok: true })
  })

  it('BURNS THE NONCE: the same body a second time is `replayed`', async () => {
    const who = await claim('hellov2burn')
    const body = claimBody(who)
    expect(await ask(who, body)).toEqual({ ok: true })
    expect(await ask(who, body)).toEqual({ ok: false, reason: 'replayed' })
    // And a third time, so the burn is not consumed by the refusal itself.
    expect(await ask(who, body)).toEqual({ ok: false, reason: 'replayed' })
  })

  it('says `stale` for a signature made outside the skew allowance', async () => {
    const who = await claim('hellov2stale')
    const old = Date.now() - HELLO_SKEW_MS - 5_000
    const origin = nameFor(who)
    const nonce = randomBytes(16).toString('base64url')
    expect(
      await ask(who, {
        deviceId: who.deviceId,
        origin,
        issuedAtMs: old,
        nonce,
        sig: signV2(who, origin, old, nonce)
      })
    ).toEqual({ ok: false, reason: 'stale' })
  })

  it('says `stale` for a clock far in the future too — skew runs both ways', async () => {
    const who = await claim('hellov2future')
    const ahead = Date.now() + HELLO_SKEW_MS + 5_000
    const origin = nameFor(who)
    const nonce = randomBytes(16).toString('base64url')
    expect(
      await ask(who, {
        deviceId: who.deviceId,
        origin,
        issuedAtMs: ahead,
        nonce,
        sig: signV2(who, origin, ahead, nonce)
      })
    ).toEqual({ ok: false, reason: 'stale' })
  })

  it('says `wrong_origin` for an origin this desktop could not answer at', async () => {
    const who = await claim('hellov2origin')
    const stranger = `https://192-168-1-24.${randomUUID()}.${ZONE}:8643`
    const issuedAtMs = Date.now()
    const nonce = randomBytes(16).toString('base64url')
    // Signed perfectly — by the right key, right now, with a fresh nonce. It
    // simply names an address that is not this device's.
    expect(
      await ask(who, {
        deviceId: who.deviceId,
        origin: stranger,
        issuedAtMs,
        nonce,
        sig: signV2(who, stranger, issuedAtMs, nonce)
      })
    ).toEqual({ ok: false, reason: 'wrong_origin' })
  })

  it('says `bad_signature` for another key, another nonce and a bent message', async () => {
    const who = await claim('hellov2sig')
    const stranger = key()
    const origin = nameFor(who)
    const issuedAtMs = Date.now()
    const nonce = randomBytes(16).toString('base64url')
    const byStranger = sign(
      null,
      Buffer.from(helloMessageV2(who.deviceId, origin, issuedAtMs, nonce), 'utf8'),
      stranger.pair.privateKey
    ).toString('base64url')
    expect(await ask(who, { deviceId: who.deviceId, origin, issuedAtMs, nonce, sig: byStranger }))
      .toEqual({ ok: false, reason: 'bad_signature' })
    // A signature over a different nonce than the one presented.
    expect(
      await ask(who, {
        deviceId: who.deviceId,
        origin,
        issuedAtMs,
        nonce: randomBytes(16).toString('base64url'),
        sig: signV2(who, origin, issuedAtMs, nonce)
      })
    ).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('answers a device this account does not hold with a bare no, and no reason', async () => {
    const who = await claim('hellov2stranger')
    const body = claimBody(who, { deviceId: randomUUID() })
    // No reason at all: a named refusal here would let a signed-in caller
    // enumerate which device ids exist on other people's accounts.
    expect(await ask(who, body)).toEqual({ ok: false })
  })

  it("accepts a bare address on the desktop's own published card", async () => {
    const who = await claim('hellov2bare')
    await publish(who)
    const origin = 'https://192.168.1.24:8643'
    const issuedAtMs = Date.now()
    const nonce = randomBytes(16).toString('base64url')
    expect(
      await ask(who, {
        deviceId: who.deviceId,
        origin,
        issuedAtMs,
        nonce,
        sig: signV2(who, origin, issuedAtMs, nonce)
      })
    ).toEqual({ ok: true })
  })
})

describe('version 1, kept for one release', () => {
  const signV1 = (who: Who, nonce: string): string =>
    sign(null, Buffer.from(helloMessage(who.deviceId, nonce), 'utf8'), who.pair.privateKey).toString(
      'base64url'
    )

  it('still verifies, because a phone runs whatever bundle it last loaded', async () => {
    const who = await claim('hellov1still')
    const nonce = randomBytes(16).toString('base64url')
    expect(await ask(who, { deviceId: who.deviceId, nonce, sig: signV1(who, nonce) })).toEqual({
      ok: true
    })
  })

  it('is burned too — the nonce is single use whichever version spent it', async () => {
    const who = await claim('hellov1burn')
    const nonce = randomBytes(16).toString('base64url')
    const body = { deviceId: who.deviceId, nonce, sig: signV1(who, nonce) }
    expect(await ask(who, body)).toEqual({ ok: true })
    expect(await ask(who, body)).toEqual({ ok: false, reason: 'replayed' })
  })
})

describe('which origins a desktop may be believed at', () => {
  const device = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const reach = {
    lan: [{ url: 'https://192.168.1.24:8643', certFp: CERT }],
    tailnet: null,
    relay: true,
    at: new Date().toISOString(),
    sig: 'x'
  }

  it('is any name under its own subdomain, whatever the zone', () => {
    expect(originBelongsTo(device, `https://192-168-1-24.${device}.${ZONE}:8643`, null)).toBe(true)
    expect(originBelongsTo(device, `https://10-0-0-9.${device}.reg.example.test`, null)).toBe(true)
  })

  it("is not another device's subdomain, and not a public host", () => {
    expect(originBelongsTo(device, `https://192-168-1-24.${randomUUID()}.${ZONE}:8643`, null)).toBe(false)
    expect(originBelongsTo(device, 'https://evil.example', null)).toBe(false)
    expect(originBelongsTo(device, `https://cookrew.dev`, null)).toBe(false)
  })

  it('is not a name whose first label is not an address', () => {
    expect(originBelongsTo(device, `https://api.${device}.${ZONE}`, null)).toBe(false)
  })

  it('is an address on its own card, and no other address', () => {
    expect(originBelongsTo(device, 'https://192.168.1.24:8643', reach)).toBe(true)
    expect(originBelongsTo(device, 'https://192.168.1.99:8643', reach)).toBe(false)
  })

  it('is never a URL with anything more than an origin in it', () => {
    const name = `https://192-168-1-24.${device}.${ZONE}:8643`
    expect(originBelongsTo(device, `${name}/api/hello`, null)).toBe(false)
    expect(originBelongsTo(device, `${name}?x=1`, null)).toBe(false)
    expect(originBelongsTo(device, `http://192-168-1-24.${device}.${ZONE}:8643`, null)).toBe(false)
    expect(originBelongsTo(device, 'not a url', null)).toBe(false)
  })
})

describe('the burn list', () => {
  const ttl = helloBurnTtlMs(HELLO_SKEW_MS)

  it('lasts exactly twice the skew, which is the whole window a signature is live', () => {
    expect(ttl).toBe(240_000)
  })

  it('spends a pair once, and lets the same nonce through for another device', () => {
    const burn = createHelloBurn(ttl)
    expect(burn.spend('a', 'n', 0)).toBe(true)
    expect(burn.spend('a', 'n', 0)).toBe(false)
    expect(burn.spend('b', 'n', 0)).toBe(true)
  })

  it('forgets an entry once no signature carrying it could still be fresh', () => {
    const burn = createHelloBurn(ttl)
    burn.spend('a', 'n', 0)
    expect(burn.spend('a', 'n', ttl - 1)).toBe(false)
    // Past the window the signature itself is `stale`, so remembering the
    // nonce protects nothing and only costs memory.
    expect(burn.spend('a', 'n', ttl + 1)).toBe(true)
  })

  it('sweeps as it goes, so a quiet minute empties it', () => {
    const burn = createHelloBurn(ttl)
    for (let i = 0; i < 50; i++) burn.spend('a', `n${i}`, 0)
    expect(burn.size()).toBe(50)
    burn.spend('a', 'later', ttl + 1)
    expect(burn.size()).toBe(1)
  })

  it('is capped, and evicts the oldest rather than the process', () => {
    const burn = createHelloBurn(ttl, 8)
    for (let i = 0; i < 100; i++) burn.spend('a', `n${i}`, 0)
    expect(burn.size()).toBe(8)
    // The oldest went, so it could be spent again — which can only ever
    // re-admit a nonce that is nearly stale anyway.
    expect(burn.spend('a', 'n0', 0)).toBe(true)
    expect(burn.spend('a', 'n99', 0)).toBe(false)
    expect(HELLO_BURN_MAX).toBe(4096)
  })
})

describe('the verifier as a pure function', () => {
  it('refuses a nonce shorter than one we would ever have issued', () => {
    const { jwk } = key()
    expect(
      verifyHelloClaim({
        jwk,
        deviceId: 'a',
        reach: null,
        claim: { nonce: 'short', sig: 'x' },
        now: 0,
        burn: createHelloBurn(1000)
      })
    ).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('does not burn a nonce a forged claim presented', () => {
    const who = key()
    const burn = createHelloBurn(1000)
    const nonce = randomBytes(16).toString('base64url')
    const origin = `https://192-168-1-24.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.${ZONE}:8643`
    const forged = verifyHelloClaim({
      jwk: who.jwk,
      deviceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      reach: null,
      claim: { origin, issuedAtMs: 0, nonce, sig: 'AAAA'.repeat(8) },
      now: 0,
      burn
    })
    expect(forged).toEqual({ ok: false, reason: 'bad_signature' })
    // The honest answer with the same nonce is still spendable, so a forgery
    // cannot be used to deny a real switch.
    expect(burn.size()).toBe(0)
  })
})
