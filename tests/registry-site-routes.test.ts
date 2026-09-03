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
import { ReleaseCache } from '../registry/src/releases'

/**
 * THE SITE OVER HTTP — pages, stars, the token key, the download redirect,
 * the bundled assets. Driven the way a browser drives it: the account signs
 * the registry's own ceremony and keeps its token in the `cr_account` cookie
 * for pages and as a Bearer for JSON.
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

const RELEASE = {
  tag_name: 'v0.1.2',
  published_at: '2026-08-28T14:05:26Z',
  html_url: 'https://github.com/cookrew/cookrew-app/releases/tag/v0.1.2',
  assets: [
    { name: 'Cookrew-0.1.2-arm64.dmg', browser_download_url: 'https://dl.example/dmg', size: 1 },
    { name: 'Cookrew-0.1.2-windows-preview-x64.exe', browser_download_url: 'https://dl.example/exe', size: 2 }
  ]
}

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
    releases: new ReleaseCache({ fetch: async () => new Response(JSON.stringify(RELEASE), { status: 200 }), ttlMs: 60_000 })
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

describe('the pages', () => {
  it('serves the homepage as a document with the real build and the directory', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain("script-src 'none'")
    const body = await res.text()
    expect(body).toContain('Cookrew gives you a team')
    expect(body).toContain('https://dl.example/dmg')
    expect(body).toContain('COOKREW Alpha')
  })

  it('serves the market and a team page as app pages with their scripts', async () => {
    const market = await get('/market?q=pilot')
    expect(market.status).toBe(200)
    expect(market.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(await market.text()).toContain('COOKREW Alpha')

    const team = await get('/@drej/cookrew-alpha')
    expect(team.status).toBe(200)
    const body = await team.text()
    expect(body).toContain('data-door="@drej/cookrew-alpha"')
    expect(body).toContain('https://cookrew.dev/drej/cookrew-alpha')
    for (const asset of ['xterm.js', 'xterm.css', 'addon-fit.js', 'site.js', 'seal.js', 'line.js']) {
      const got = await get(`/assets/${asset}`)
      expect(got.status, asset).toBe(200)
      expect(got.headers.get('content-type')).toContain(asset.endsWith('.css') ? 'text/css' : 'text/javascript')
    }
    expect((await get('/assets/nope.js')).status).toBe(404)
    expect((await get('/assets/../package.json')).status).toBe(404)
  })

  it('a reserved name is a route, never a handle', async () => {
    expect((await get('/market')).status).toBe(200)
    expect((await get('/download')).status).toBe(302)
  })
})

describe('/download', () => {
  it('sends a Mac to the dmg, Windows to the exe, anyone else to the release page', async () => {
    const mac = await get('/download', { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)' })
    expect(mac.status).toBe(302)
    expect(mac.headers.get('location')).toBe('https://dl.example/dmg')
    expect((await get('/download?platform=windows')).headers.get('location')).toBe('https://dl.example/exe')
    expect((await get('/download', { 'user-agent': 'curl/8' })).headers.get('location')).toBe(RELEASE.html_url)
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
  it('toggle per account, count for everyone, and render on the pages', async () => {
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

    const page = await (await get('/@drej/cookrew-alpha', { cookie: `cr_account=${token}` })).text()
    expect(page).toContain('class="star on"')
    const mine = await (await get('/market?tab=starred', { cookie: `cr_account=${token}` })).text()
    expect(mine).toContain('COOKREW Alpha')

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
    expect(doors.register('drej', { ...base, name: 'x', summary: 'fine ' })).toMatchObject({ ok: false, reason: 'bad-face' })
  })
})
