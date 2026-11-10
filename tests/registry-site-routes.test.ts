import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { Pulse } from '../registry/src/pulse'

/**
 * WHAT THE SITE USED TO ASK THE REGISTRY, OVER HTTP — stars, the token key,
 * who a token names, a door's face and today's counts. The pages that asked
 * are gone (0.6.0; tests/registry-no-site.test.ts holds that); the routes
 * stay, driven the way a client drives them: the account signs the registry's
 * own ceremony and presents its token as a Bearer, or in the older
 * `cr_account` cookie where a read still takes it.
 */

const CONFIG = { rpId: 'localhost', origin: 'http://localhost:8790', tokenTtlMs: 600_000, challengeTtlMs: 90_000 }
const b64 = (b: Buffer): string => b.toString('base64url')

function authenticator(handle: string, keys: { privateKey: KeyObject }) {
  const rpIdHash = createHash('sha256').update(CONFIG.rpId).digest()
  return (challenge: string) => {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', origin: CONFIG.origin, challenge }), 'utf8')
    const data = Buffer.concat([rpIdHash, Buffer.from([0x01]), Buffer.from([0, 0, 0, 1])])
    const signature = sign(null, Buffer.concat([data, createHash('sha256').update(clientData).digest()]), keys.privateKey)
    return { credentialId: handle, clientDataJSON: b64(clientData), authenticatorData: b64(data), signature: b64(signature) }
  }
}

let dir = ''
let origin = ''
let close: () => Promise<void> = async () => undefined
let identity: IdentityService
let doors: DoorStore

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'site-routes-'))
  identity = new IdentityService(dir, CONFIG)
  doors = new DoorStore(dir, { allowPrivate: true })
  const server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity,
    doors,
    relay: true,
    origin: 'https://cookrew.dev',
    stars: new StarStore(dir),
    pulse: new Pulse(dir)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  doors.register('drej', {
    handle: 'drej',
    name: 'cookrew-alpha',
    title: 'COOKREW Alpha',
    door: 'Pilot',
    agents: 3,
    address: 'https://cookrew.dev/@drej/cookrew-alpha',
    transport: 'relay',
    access: 'account',
    rails: [],
    sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab',
    summary: 'The crew that builds Cookrew.',
    tags: ['dev'],
    harnesses: ['Claude Code', 'Pi']
  })
})
afterAll(async () => {
  await close()
  rmSync(dir, { recursive: true, force: true })
})

const get = (p: string, headers: Record<string, string> = {}) => fetch(`${origin}${p}`, { headers, redirect: 'manual' })
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${origin}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

async function signIn(handle: string, scope = 'download', aud?: string): Promise<string> {
  const keys = generateKeyPairSync('ed25519')
  const enrol = await post('/v1/identity/register', { credentialId: handle, publicKeyJwk: keys.publicKey.export({ format: 'jwk' }) })
  expect([201, 409]).toContain(enrol.status)
  const challenge = (await (await post('/v1/identity/challenge', {})).json()) as { challenge: string }
  const asserted = await post('/v1/identity/assert', { ...authenticator(handle, keys)(challenge.challenge), scope, ...(aud ? { aud } : {}) })
  expect(asserted.status).toBe(200)
  return ((await asserted.json()) as { token: string }).token
}

describe('the directory, as data', () => {
  it('a door on the wire carries today’s counts', async () => {
    const one = (await (await get('/v1/doors/@drej/cookrew-alpha')).json()) as { today: { lines: number; calls: number } }
    expect(one.today).toEqual({ lines: 0, calls: 0 })
  })
})

describe('identity for the site', () => {
  it('hands out a challenge, its public token key, and says who a token names', async () => {
    const challenge = await post('/v1/identity/challenge', {})
    expect(challenge.status).toBe(200)
    expect(((await challenge.json()) as { challenge: string }).challenge.length).toBeGreaterThan(10)

    const key = await get('/v1/identity/key')
    expect(key.status).toBe(200)
    const jwk = ((await key.json()) as { jwk: { kty: string; crv: string; x: string } }).jwk
    expect(jwk.kty).toBe('OKP')
    expect(jwk.crv).toBe('Ed25519')

    const token = await signIn('mira')
    const who = await get('/v1/identity/whoami', { authorization: `Bearer ${token}` })
    expect(await who.json()).toEqual({ sub: 'mira' })
    const viaCookie = await get('/v1/identity/whoami', { cookie: `cr_account=${token}` })
    expect(viaCookie.status).toBe(200)
    expect((await get('/v1/identity/whoami')).status).toBe(401)
  })

  it('mints a call token for one door, and that token names nobody on this site', async () => {
    const token = await signIn('ozan', 'call', '@drej/cookrew-alpha')
    const claims = identity.verifyToken(token)
    expect(claims).toMatchObject({ sub: 'ozan', scope: 'call', aud: '@drej/cookrew-alpha' })
    expect((await get('/v1/identity/whoami', { authorization: `Bearer ${token}` })).status).toBe(401)
    // A call token needs a door.
    const keys = generateKeyPairSync('ed25519')
    await post('/v1/identity/register', { credentialId: 'lin', publicKeyJwk: keys.publicKey.export({ format: 'jwk' }) })
    const challenge = (await (await post('/v1/identity/challenge', {})).json()) as { challenge: string }
    const bare = await post('/v1/identity/assert', { ...authenticator('lin', keys)(challenge.challenge), scope: 'call' })
    expect(bare.status).toBe(401)
  })
})

describe('stars', () => {
  it('toggle per account, and count for everyone', async () => {
    const token = await signIn('sasha')
    expect((await post('/v1/doors/@drej/cookrew-alpha/star', {})).status).toBe(401)
    const on = await post('/v1/doors/@drej/cookrew-alpha/star', {}, { authorization: `Bearer ${token}` })
    expect(await on.json()).toEqual({ stars: 1, starred: true })
    const seen = await get('/v1/doors/@drej/cookrew-alpha/star', { cookie: `cr_account=${token}` })
    expect(await seen.json()).toEqual({ stars: 1, starred: true })
    const stranger = await get('/v1/doors/@drej/cookrew-alpha/star')
    expect(await stranger.json()).toEqual({ stars: 1, starred: false })

    const listed = (await (await get('/v1/doors')).json()) as { doors: { name: string; stars: number }[] }
    expect(listed.doors.find((d) => d.name === 'cookrew-alpha')?.stars).toBe(1)

    const off = await post('/v1/doors/@drej/cookrew-alpha/star', {}, { authorization: `Bearer ${token}` })
    expect(await off.json()).toEqual({ stars: 0, starred: false })
    expect((await post('/v1/doors/@nobody/nothing/star', {}, { authorization: `Bearer ${token}` })).status).toBe(404)
  })
})

describe('the face on the wire', () => {
  it('a door lists its summary, tags and harnesses, verbatim, and searches by them', async () => {
    const one = (await (await get('/v1/doors/@drej/cookrew-alpha')).json()) as Record<string, unknown>
    expect(one.summary).toBe('The crew that builds Cookrew.')
    expect(one.tags).toEqual(['dev'])
    expect(one.harnesses).toEqual(['Claude Code', 'Pi'])
    const found = (await (await get('/v1/doors?q=builds')).json()) as { doors: unknown[] }
    expect(found.doors).toHaveLength(1)
  })

  it('refuses a face that is out of bounds', () => {
    const base = { ...doors.get('drej', 'cookrew-alpha')!, address: 'https://cookrew.dev/@drej/x' }
    expect(doors.register('drej', { ...base, name: 'x', summary: 'a'.repeat(161) })).toMatchObject({ ok: false, reason: 'bad-face' })
    expect(doors.register('drej', { ...base, name: 'x', tags: ['Bad Tag'] })).toMatchObject({ ok: false, reason: 'bad-face' })
    expect(doors.register('drej', { ...base, name: 'x', tags: ['a', 'b', 'c', 'd', 'e', 'f'] })).toMatchObject({ ok: false, reason: 'bad-face' })
    expect(doors.register('drej', { ...base, name: 'x', harnesses: ['x'.repeat(33)] })).toMatchObject({ ok: false, reason: 'bad-face' })
    expect(doors.register('drej', { ...base, name: 'x', summary: 'fine\u0000' })).toMatchObject({ ok: false, reason: 'bad-face' })
  })
})
