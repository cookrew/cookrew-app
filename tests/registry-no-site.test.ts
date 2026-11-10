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
import { Pulse } from '../registry/src/pulse'
import { createV2 } from '../registry/src/v2-routes'
import { ASSETS } from '../registry/src/assets-bundle'
import { page, withStaticSite } from '../registry/src/site-shell'
import { mePage } from '../registry/src/site-account'
import { featurePage } from '../registry/src/site-features'
import { privacyPage } from '../registry/src/site-legal'
import { FEATURES } from '../registry/src/site-content'

/**
 * THE REGISTRY SERVES NO SITE (0.6.0).
 *
 * cookrew.dev is a static site, the account page is the auth host's and the
 * machines are the console's. A registry started as one host (`--dev` style:
 * no auth origin, no API origin) used to render the home page, the market, a
 * person's page, a team's page, /me, /join, the install page, the feature
 * pages and the crawl files. It answers none of them now: each is the same
 * 404 as any path nobody routes, as data, and reads and sets no cookie.
 *
 * And the shell that drew them draws exactly two things: a page of the static
 * site, and the standalone account page. Asked for anything else, it throws.
 */

const PASSWORD = 'correct horse battery staple'
const PRESET = `sha256:${'a'.repeat(64)}`

let dir = ''
let origin = ''
let session = ''
let close: () => Promise<void> = async () => undefined

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'no-site-'))
  const doors = new DoorStore(dir, { allowPrivate: true })
  const server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors,
    relay: true,
    dev: true,
    stars: new StarStore(dir),
    pulse: new Pulse(dir),
    origin: 'https://cookrew.dev',
    v2: createV2(dir, { secondStep: 'legacy', limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  // A real account that serves a real team: the pages that are gone were about exactly these.
  const made = await fetch(`${origin}/v2/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'someone',
      password: PASSWORD,
      device: { id: randomUUID(), kind: 'browser', name: 'Chrome on macOS', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' } }
    })
  })
  expect(made.status).toBe(201)
  session = ((await made.json()) as { session: { token: string } }).session.token
  const listed = doors.register('someone', {
    handle: 'someone',
    name: 'team',
    title: 'A Team',
    door: 'Pilot',
    agents: 2,
    address: 'https://cookrew.dev/@someone/team',
    transport: 'relay',
    access: 'account',
    rails: [],
    sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab'
  })
  expect(listed.ok).toBe(true)
})
afterAll(async () => {
  await close()
  rmSync(dir, { recursive: true, force: true })
})

/** Every address that used to be a page, a crawl file, an asset or a redirect of the registry's own site. */
const GONE = [
  '/',
  '/market',
  '/market?q=team',
  '/@someone',
  '/someone',
  '/@someone/team',
  '/someone/team',
  '/@someone/team?buy=1',
  '/me',
  '/me/account',
  '/me?stepup=done',
  '/join',
  `/install/${PRESET}`,
  '/install/abc',
  '/features',
  '/start',
  '/features/canvas',
  `/features/${FEATURES[0].slug}`,
  '/privacy',
  '/terms',
  '/download',
  '/download?platform=mac',
  '/robots.txt',
  '/sitemap.xml',
  '/llms.txt',
  '/favicon.svg',
  '/favicon.ico',
  '/site.webmanifest',
  '/assets/site.js',
  '/assets/inter.woff2',
  '/assets/line.js',
  '/assets/xterm.js'
]

describe('a registry on one host serves no page', () => {
  it.each(GONE)('GET %s is a 404, as data, and sets no cookie', async (address) => {
    const response = await fetch(`${origin}${address}`, { redirect: 'manual' })
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await response.json()).toEqual({ error: 'not_found' })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('location')).toBeNull()
  })

  it.each(GONE)('GET %s answers a signed-in browser the same: the cookie opens no page', async (address) => {
    const response = await fetch(`${origin}${address}`, { redirect: 'manual', headers: { cookie: `__Host-cr_session=${session}` } })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it.each(['/', '/market', '/privacy', '/robots.txt', '/features/canvas'])('HEAD %s is a 404 too', async (address) => {
    const response = await fetch(`${origin}${address}`, { method: 'HEAD', redirect: 'manual' })
    expect(response.status).toBe(404)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('still answers the API beside them: the cut took pages, never data', async () => {
    const health = await fetch(`${origin}/v1/health`)
    expect(health.status).toBe(200)
    const described = (await health.json()) as { ok: boolean; routes: string[] }
    expect(described.ok).toBe(true)
    // The self-description lists what is mounted, so the install page left it with the page.
    expect(described.routes).not.toContain('GET /install/:presetId')
    expect(described.routes).toContain('GET /v1/presets?q=')

    const directory = (await (await fetch(`${origin}/v1/doors`)).json()) as { doors: { handle: string; name: string; live: boolean; stars: number }[] }
    expect(directory.doors.map((door) => `@${door.handle}/${door.name}`)).toEqual(['@someone/team'])
    expect(directory.doors[0]).toMatchObject({ live: false, stars: 0, today: { lines: 0, calls: 0 } })
    expect((await fetch(`${origin}/v1/doors/@someone/team`)).status).toBe(200)

    const me = await fetch(`${origin}/v2/me`, { headers: { authorization: `Bearer ${session}` } })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { username: string }).username).toBe('someone')
    expect((await fetch(`${origin}/v1/presets`)).status).toBe(200)
  })
})

describe('the bundle carries only what a remaining page loads', () => {
  it('is the account page’s scripts, the sign-in page’s scripts and the two fonts', () => {
    expect(Object.keys(ASSETS).sort()).toEqual(
      ['auth-enrol.js', 'auth-grant.js', 'auth-kit.js', 'auth-step.js', 'auth.js', 'device-id.js', 'factors.js', 'inter.woff2', 'jetbrains-mono.woff2', 'site.js', 'step-up.js'].sort()
    )
  })

  it('every script the account page names is in it', () => {
    const standalone = { site: 'https://cookrew.dev', console: 'https://console.cookrew.dev', home: '/account' }
    const named = [...mePage(null, standalone).body.matchAll(/<script src="\/assets\/([A-Za-z0-9._-]+)\?v=/g)].map(([, name]) => name)
    expect(named).toEqual(['device-id.js', 'site.js', 'factors.js'])
    for (const name of named) expect(ASSETS[name], name).toBeDefined()
  })
})

describe('the shell draws a page of the static site or the standalone account page, and nothing else', () => {
  const STATIC = { console: 'https://console.cookrew.dev', auth: 'https://auth.cookrew.dev' }
  const STANDALONE = { site: 'https://cookrew.dev', console: 'https://console.cookrew.dev', home: '/account' }

  it('page() throws outside both modes, naming the page and the two modes', () => {
    expect(() => page({ title: 'A stray page', kind: 'document' }, '<p>x</p>')).toThrow(/A stray page/)
    expect(() => page({ title: 'A stray page', kind: 'app', scripts: ['site.js'] }, '<p>x</p>')).toThrow(/withStaticSite.*standalone/)
  })

  it('so does every builder that is only a page of the static site', () => {
    expect(() => featurePage(FEATURES[0].slug)).toThrow(/outside both modes/)
    expect(() => privacyPage()).toThrow(/outside both modes/)
  })

  it('draws the static site inside withStaticSite: a document, with the way to the console and no account', () => {
    const drawn = withStaticSite(STATIC, () => page({ title: 'Static', kind: 'document' }, '<p>x</p>'))
    expect(drawn.status).toBe(200)
    expect(drawn.headers['content-security-policy']).toContain("script-src 'none'")
    expect(drawn.body).toContain('href="https://console.cookrew.dev/"')
    expect(drawn.body).toContain('href="https://auth.cookrew.dev/account"')
    expect(drawn.body).not.toContain('<script src=')
    expect(drawn.body).not.toContain('id="account-sheet"')
  })

  it('the static mode ends with the build: a page drawn afterwards throws again', () => {
    withStaticSite(STATIC, () => page({ title: 'Static', kind: 'document' }, ''))
    expect(() => page({ title: 'Late', kind: 'document' }, '')).toThrow(/Late/)
    // And when the render itself fails.
    expect(() =>
      withStaticSite(STATIC, () => {
        throw new Error('render failed')
      })
    ).toThrow('render failed')
    expect(() => page({ title: 'Later', kind: 'document' }, '')).toThrow(/Later/)
  })

  it('draws a standalone page with its own header: whole addresses out, the account sheet, no site navigation', () => {
    const drawn = page({ title: 'Alone', kind: 'app', scripts: ['device-id.js', 'site.js'], cache: 0, standalone: STANDALONE }, '<p>x</p>')
    expect(drawn.headers['cache-control']).toBe('private, no-store')
    expect(drawn.body).toContain('<body data-home="/account">')
    expect(drawn.body).toContain('href="https://cookrew.dev/"')
    expect(drawn.body).toContain('href="https://console.cookrew.dev/"')
    expect(drawn.body).toContain('id="account-sheet"')
    expect(drawn.body).toContain('data-signin')
  })

  it('no page of either mode links the pages that are gone', () => {
    const pages = [
      withStaticSite(STATIC, () => page({ title: 'Static', kind: 'document' }, '')).body,
      ...FEATURES.map((feature) => withStaticSite(STATIC, () => featurePage(feature.slug))?.body ?? ''),
      mePage(null, STANDALONE).body,
      page({ title: 'Alone', kind: 'document', standalone: STANDALONE }, '').body
    ]
    for (const body of pages) {
      expect(body).not.toMatch(/href="\/market/)
      expect(body).not.toMatch(/href="\/me\b/)
      expect(body).not.toMatch(/href="\/install\//)
      expect(body).not.toMatch(/href="\/(download|start)"/)
    }
  })
})
