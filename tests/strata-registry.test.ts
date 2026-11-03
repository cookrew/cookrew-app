import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type ClientRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DoorStore } from '../registry/src/doors'
import { IdentityService } from '../registry/src/identity'
import { TransparencyLog } from '../registry/src/log'
import { createRegistry } from '../registry/src/server'
import { ART_MANIFEST, composeSampleArt } from '../registry/src/site-art'
import { RegistryStore } from '../registry/src/store'
import { StarStore } from '../registry/src/stars'
import { loadShellBundle, readShellBundle } from '../registry/src/strata-shell'
import { LINKS_PER_ACCOUNT } from '../registry/src/v2-canvas-relay'
import { BAD, fleetPresence, fleetRow, PROFILE_BYTES_MAX, readAppVersion, readProfile, type DesktopPresence } from '../registry/src/v2-fleet'
import { createLineSeen, SEEN_KEEP_MS } from '../registry/src/v2-line-seen'
import type { V2Desktop } from '../registry/src/v2-accounts'
import { createV2 } from '../registry/src/v2-routes'
import { decodeFrame, encodeFrame } from '../src/shared/relay-frame'
import type { FleetMachine, MachineProfile } from '../src/shared/strata'
import { checkProfile } from './strata-levels-shape'

// Strata on the registry: the desktop record's profile, the FleetMachine rows,
// the batch presence answer and /me as level 0 — over real HTTP on loopback.
// Every account, machine and name is invented.

const PASSWORD = 'correct horse battery staple'

const PROFILE: MachineProfile = {
  kind: 'laptop',
  model: 'MacBookPro18,1',
  label: 'MacBook Pro 16-inch (2021)',
  vendor: 'Apple',
  os: 'darwin',
  osVersion: 'macOS 26.5',
  arch: 'arm64',
  cpus: 10,
  memoryGb: 32,
  evidence: ['hw.model=MacBookPro18,1', 'battery=present']
}

const FLEET_KEYS = ['appVersion', 'base', 'id', 'lastSeenAt', 'name', 'online', 'profile']

describe('reading a profile off the record PUT', () => {
  it('takes a well-formed profile and drops members the contract does not name', () => {
    expect(readProfile(PROFILE)).toEqual(PROFILE)
    expect(readProfile({ ...PROFILE, hostname: 'someones-mbp', serial: 'X' })).toEqual(PROFILE)
    expect(() => checkProfile(readProfile(PROFILE), 'profile')).not.toThrow()
  })

  it('tells absent from cleared', () => {
    expect(readProfile(undefined)).toBeUndefined()
    expect(readProfile(null)).toBeNull()
    expect(readAppVersion(undefined)).toBeUndefined()
    expect(readAppVersion(null)).toBeNull()
  })

  it('refuses a malformed, oversized or identifier-carrying profile', () => {
    const bad: unknown[] = [
      'laptop',
      [],
      { ...PROFILE, kind: 'mainframe' },
      { ...PROFILE, os: 'beos' },
      { ...PROFILE, arch: null },
      { ...PROFILE, cpus: -1 },
      { ...PROFILE, cpus: 1.5 },
      { ...PROFILE, model: 'x'.repeat(65) },
      { ...PROFILE, label: 'line\nbreak' },
      { ...PROFILE, vendor: '4C4C4544-0042-3510-8051-B4C04F4D3732' },
      { ...PROFILE, evidence: ['mac=a4:83:e7:12:34:56'] },
      { ...PROFILE, evidence: Array.from({ length: 13 }, (_, i) => `fact=${i}`) },
      { ...PROFILE, evidence: [null] },
      { ...PROFILE, evidence: 'battery=present' },
      { ...PROFILE, extra: 'y'.repeat(PROFILE_BYTES_MAX) }
    ]
    for (const raw of bad) expect(readProfile(raw), JSON.stringify(raw).slice(0, 80)).toBe(BAD)
  })

  it('takes a version string and refuses anything else', () => {
    expect(readAppVersion('0.3.0')).toBe('0.3.0')
    expect(readAppVersion('0.4.0-beta.2+build.7')).toBe('0.4.0-beta.2+build.7')
    for (const raw of [3, '', 'v'.repeat(33), '0.3.0 <script>', '../../etc']) expect(readAppVersion(raw)).toBe(BAD)
  })
})

describe('a FleetMachine row', () => {
  const desktop = { deviceId: 'd1', name: 'Invented Mac', workspaces: [], reach: null, updatedAt: 1_000 }

  it('is online now, or last seen at the later of the line and the record', () => {
    expect(fleetRow('mira', desktop, { online: true, lastSeenAt: 500 }, 9_000)).toMatchObject({ online: true, lastSeenAt: 9_000 })
    expect(fleetRow('mira', desktop, { online: false, lastSeenAt: 5_000 }, 9_000)).toMatchObject({ online: false, lastSeenAt: 5_000 })
    expect(fleetRow('mira', desktop, undefined, 9_000)).toMatchObject({ online: false, lastSeenAt: 1_000 })
  })

  it('draws an older desktop as unknown and names its base', () => {
    const row = fleetRow('mira', desktop, undefined, 9_000)
    expect(row).toEqual({ id: 'd1', name: 'Invented Mac', online: false, lastSeenAt: 1_000, appVersion: null, profile: null, base: '/relay/@mira/desktop/d1/' })
  })
})

describe('a presence row means what its list row means', () => {
  it('equals the list row’s id, online and lastSeenAt at the same instant, for every kind of desktop', () => {
    const at = (deviceId: string, updatedAt: number): V2Desktop => ({ deviceId, name: deviceId, workspaces: [], reach: null, updatedAt })
    const desktops = [at('online', 1_000), at('seen-later', 1_000), at('record-later', 8_000), at('record-only', 2_000), at('never', 0)]
    const lines = new Map<string, DesktopPresence>([
      ['online', { online: true, lastSeenAt: 500 }],
      ['seen-later', { online: false, lastSeenAt: 7_000 }],
      ['record-later', { online: false, lastSeenAt: 3_000 }],
      // After a registry restart the relay has no sighting at all: the record PUT time stands.
      ['record-only', { online: false, lastSeenAt: null }]
    ])
    const now = 9_000
    const presence = fleetPresence(desktops, lines, 8, now)
    expect(presence).toMatchObject({ at: now, cap: 8, online: 1 })
    for (const desktop of desktops) {
      const row = fleetRow('mira', desktop, lines.get(desktop.deviceId), now)
      expect(presence.desktops.find((d) => d.id === desktop.deviceId)).toEqual({ id: row.id, online: row.online, lastSeenAt: row.lastSeenAt })
    }
    expect(presence.desktops.map((d) => d.lastSeenAt)).toEqual([9_000, 7_000, 8_000, 2_000, null])
  })
})

describe('line sightings survive a restart', () => {
  it('writes once per window, atomically, and reads back what it wrote', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'strata-seen-')), 'seen.json')
    let now = 1_000_000
    const first = createLineSeen(file, () => now, 60_000)
    first.see('@mira/desktop/a')
    now += 5
    first.see('@mira/desktop/b')
    first.flush()
    const second = createLineSeen(file, () => now)
    expect(second.get('@mira/desktop/a')).toBe(1_000_000)
    expect(second.get('@mira/desktop/b')).toBe(1_000_005)
  })

  it('forgets sightings older than the keep window, and survives a torn file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'strata-seen-'))
    const file = path.join(dir, 'seen.json')
    const now = SEEN_KEEP_MS * 3
    writeFileSync(file, JSON.stringify({ old: now - SEEN_KEEP_MS - 1, fresh: now - 1, bad: 'x' }))
    const seen = createLineSeen(file, () => now)
    expect([seen.get('old'), seen.get('fresh'), seen.get('bad')]).toEqual([undefined, now - 1, undefined])
    writeFileSync(file, '{"torn":')
    expect(createLineSeen(file, () => now).get('torn')).toBeUndefined()
  })
})

// ── over HTTP ───────────────────────────────────────────────────────────────

interface Up {
  origin: string
  close: () => Promise<void>
}

const listen = async (server: Server): Promise<Up> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

const jwkOf = (): Record<string, string> => generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, string>

let dir = ''
let site: Up
let shellSite: Up
let shellFile = ''
/** A shell deployed without --strata-me: it only draws the front page's sample. */
let artSite: Up

async function claim(origin: string, name: string): Promise<{ id: string; token: string }> {
  const id = randomUUID()
  const res = await fetch(`${origin}/v2/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, password: PASSWORD, device: { id, kind: 'desktop', name: 'A machine', jwk: jwkOf() } })
  })
  expect(res.status).toBe(201)
  return { id, token: ((await res.json()) as { session: { token: string } }).session.token }
}

const put = (origin: string, desktop: { id: string; token: string }, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${origin}/v2/me/desktops/${desktop.id}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${desktop.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Invented Mac', workspaces: [{ id: 'w1', name: 'Alpha' }], ...body })
  })

const desktops = async (origin: string, token: string): Promise<Array<FleetMachine & Record<string, unknown>>> => {
  const res = await fetch(`${origin}/v2/me/desktops`, { headers: { authorization: `Bearer ${token}` } })
  expect(res.status).toBe(200)
  return (await res.json()) as Array<FleetMachine & Record<string, unknown>>
}

/** A desktop's relay line, the minimum that holds it: a downlink, an uplink, a pong per ping. */
function holdLine(origin: string, desktop: { id: string; token: string }): { ready: Promise<void>; close: () => void } {
  const address = `${origin}/v2/canvas/link/${desktop.id}`
  const headers = { authorization: `Bearer ${desktop.token}` }
  const up: ClientRequest = httpRequest(address, { method: 'POST', headers }, () => undefined)
  up.on('error', () => undefined)
  let settle: () => void = () => undefined
  const ready = new Promise<void>((resolve) => (settle = resolve))
  const down = httpRequest(address, { method: 'GET', headers }, (res) => {
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', (text: string) => {
      buffer += text
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const frame = decodeFrame(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
        if (frame?.t === 'ready') settle()
        else if (frame?.t === 'ping') up.write(`${encodeFrame({ t: 'pong', at: frame.at })}\n`)
      }
    })
  })
  down.on('error', () => undefined)
  down.end()
  return {
    ready,
    close: () => {
      up.destroy()
      down.destroy()
    }
  }
}

const registry = (shell: ReturnType<typeof loadShellBundle>, strataMe = true): Server =>
  createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    origin: 'https://cookrew.dev',
    v2: createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 } }),
    shell,
    strataMe
  })

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'strata-registry-'))
  shellFile = path.join(dir, 'strata-shell-assets.json')
  // The front page's sample pictures ride in the shell's bundle, as strata-build.mjs puts them there.
  const art = composeSampleArt()
  const pictures = Object.fromEntries(Object.entries(art.files).map(([file, svg]) => [file, { type: 'image/svg+xml', body: svg }]))
  writeFileSync(
    shellFile,
    JSON.stringify({
      version: 'abc123',
      index: '<!doctype html><title>Strata</title><script type="module" src="/strata/assets/index-abc123.js"></script><div id="root"></div>',
      files: {
        'assets/index-abc123.js': { type: 'text/javascript; charset=utf-8', body: 'export {}' },
        'favicon.svg': { type: 'image/svg+xml', body: '<svg/>' },
        ...pictures,
        [ART_MANIFEST]: { type: 'application/json', body: JSON.stringify(art.manifest) }
      }
    })
  )
  site = await listen(registry(null))
  shellSite = await listen(registry(loadShellBundle(shellFile)))
  artSite = await listen(registry(loadShellBundle(shellFile), false))
})

afterAll(async () => {
  await site.close()
  await shellSite.close()
  await artSite.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the desktop record carries profile and appVersion', () => {
  it('files them, lists them as FleetMachine rows, and keeps them across a PUT that does not say', async () => {
    const mac = await claim(site.origin, 'mira')
    expect((await put(site.origin, mac, { profile: PROFILE, appVersion: '0.3.0' })).status).toBe(204)
    let [row] = await desktops(site.origin, mac.token)
    for (const key of FLEET_KEYS) expect(row).toHaveProperty(key)
    expect(row).toMatchObject({ id: mac.id, name: 'Invented Mac', online: false, appVersion: '0.3.0', profile: PROFILE, base: `/relay/@mira/desktop/${mac.id}/` })
    // Every member a client read before is still on the row.
    expect(row).toMatchObject({ deviceId: mac.id, workspaces: [{ id: 'w1', name: 'Alpha' }], doors: [], reach: null })
    expect(typeof row.lastSeenAt).toBe('number')

    expect((await put(site.origin, mac, {})).status).toBe(204)
    ;[row] = await desktops(site.origin, mac.token)
    expect(row).toMatchObject({ appVersion: '0.3.0', profile: PROFILE })

    expect((await put(site.origin, mac, { profile: null, appVersion: null })).status).toBe(204)
    ;[row] = await desktops(site.origin, mac.token)
    expect(row).toMatchObject({ appVersion: null, profile: null })
  })

  it('refuses a bad profile and keeps the one filed', async () => {
    const mac = await claim(site.origin, 'nell')
    await put(site.origin, mac, { profile: PROFILE, appVersion: '0.3.0' })
    const refused = await put(site.origin, mac, { profile: { ...PROFILE, vendor: '4C4C4544-0042-3510-8051-B4C04F4D3732' } })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: 'bad_desktop' })
    expect((await put(site.origin, mac, { appVersion: '<b>' })).status).toBe(400)
    expect((await put(site.origin, mac, { profile: { ...PROFILE, evidence: 'x'.repeat(20_000) } })).status).toBe(413)
    const [row] = await desktops(site.origin, mac.token)
    expect(row.profile).toEqual(PROFILE)
  })

  it('lets only that desktop describe itself', async () => {
    const mac = await claim(site.origin, 'otto')
    const other = { id: randomUUID(), token: mac.token }
    expect((await put(site.origin, other, { profile: PROFILE })).status).toBe(403)
  })
})

describe('presence, one question for the fleet', () => {
  it('says online while a desktop holds its line, with the cap, and remembers when it left', async () => {
    const mac = await claim(site.origin, 'pip')
    await put(site.origin, mac, { profile: PROFILE, appVersion: '0.3.0' })
    const ask = async () => {
      const res = await fetch(`${site.origin}/v2/me/presence`, { headers: { authorization: `Bearer ${mac.token}` } })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('no-store')
      return (await res.json()) as { at: number; cap: number; online: number; desktops: Array<{ id: string; online: boolean; lastSeenAt: number | null }> }
    }
    const before = await ask()
    expect(before).toMatchObject({ cap: LINKS_PER_ACCOUNT, online: 0, desktops: [{ id: mac.id, online: false }] })
    // Never on a line yet: the record PUT time, exactly as the list row says.
    const [listed] = await desktops(site.origin, mac.token)
    expect(before.desktops[0].lastSeenAt).toBe(listed.lastSeenAt)
    expect(listed.lastSeenAt).toBeGreaterThan(0)

    const line = holdLine(site.origin, mac)
    await line.ready
    const up = await ask()
    expect(up).toMatchObject({ online: 1, desktops: [{ id: mac.id, online: true }] })
    expect(up.desktops[0].lastSeenAt).toBeGreaterThan(0)
    const [row] = await desktops(site.origin, mac.token)
    expect(row).toMatchObject({ online: true })

    line.close()
    let gone = await ask()
    for (let i = 0; i < 50 && gone.online > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      gone = await ask()
    }
    expect(gone.desktops[0]).toMatchObject({ online: false })
    expect(gone.desktops[0].lastSeenAt).toBeGreaterThan(0)
  })

  it('after a restart, reads a line seen in the last run and agrees with the list', async () => {
    const restartDir = mkdtempSync(path.join(tmpdir(), 'strata-registry-restart-'))
    const seenFile = path.join(restartDir, 'canvas-line-seen.json')
    const make = (): Server =>
      createRegistry({
        store: new RegistryStore(restartDir),
        log: new TransparencyLog(restartDir),
        identity: new IdentityService(restartDir),
        stars: new StarStore(restartDir),
        origin: 'https://cookrew.dev',
        v2: createV2(restartDir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 } }),
        lineSeenFile: seenFile
      })
    const first = await listen(make())
    const mac = await claim(first.origin, 'vale')
    await put(first.origin, mac, {})
    await first.close()
    // What the last run wrote: the line seen well after the record was filed.
    const lineAt = Date.now() + 60_000
    writeFileSync(seenFile, JSON.stringify({ [`@vale/desktop/${mac.id}`]: lineAt }))
    const second = await listen(make())
    try {
      const presence = (await (await fetch(`${second.origin}/v2/me/presence`, { headers: { authorization: `Bearer ${mac.token}` } })).json()) as {
        desktops: Array<{ id: string; online: boolean; lastSeenAt: number | null }>
      }
      const [row] = await desktops(second.origin, mac.token)
      expect(presence.desktops).toEqual([{ id: mac.id, online: false, lastSeenAt: lineAt }])
      expect({ id: row.id, online: row.online, lastSeenAt: row.lastSeenAt }).toEqual(presence.desktops[0])
    } finally {
      await second.close()
      rmSync(restartDir, { recursive: true, force: true })
    }
  })

  it('answers only about the reader’s own desktops, and needs a session', async () => {
    const mine = await claim(site.origin, 'quill')
    await put(site.origin, mine, {})
    const theirs = await claim(site.origin, 'rook')
    await put(site.origin, theirs, {})
    const res = await fetch(`${site.origin}/v2/me/presence`, { headers: { authorization: `Bearer ${mine.token}` } })
    const body = (await res.json()) as { desktops: Array<{ id: string }> }
    expect(body.desktops.map((d) => d.id)).toEqual([mine.id])
    expect((await fetch(`${site.origin}/v2/me/presence`)).status).toBe(401)
  })
})

describe('/me as level 0', () => {
  let token = ''
  beforeAll(async () => {
    token = (await claim(shellSite.origin, 'sage')).token
  })

  const page = (origin: string, at: string, signedIn = true) =>
    fetch(`${origin}${at}`, { headers: signedIn ? { authorization: `Bearer ${token}` } : {} })

  it('serves the shell at /me and every level under it, with frame-src self', async () => {
    for (const at of ['/me', '/me/m1', '/me/m1/w1', '/me/m1/w1/a1']) {
      const res = await page(shellSite.origin, at)
      expect(res.status, at).toBe(200)
      expect(await res.text()).toContain('/strata/assets/index-abc123.js')
      const csp = res.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("frame-src 'self'")
      expect(csp).toContain("script-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(res.headers.get('cache-control')).toBe('private, no-store')
    }
  })

  it('moves the account page to /me/account', async () => {
    const res = await page(shellSite.origin, '/me/account')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('id="me-desktops"')
    expect(html).not.toContain('/strata/assets/')
  })

  it('sends a signed-out reader to the sign-in page, never the shell', async () => {
    for (const at of ['/me', '/me/m1/w1']) {
      const res = await page(shellSite.origin, at, false)
      expect(res.status, at).toBe(401)
      expect(await res.text()).not.toContain('/strata/assets/')
    }
  })

  it('sends a signed-in reader from the front page to their fleet; a signed-out one gets the front page', async () => {
    const mine = await fetch(`${shellSite.origin}/`, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' })
    expect(mine.status).toBe(302)
    expect(mine.headers.get('location')).toBe('/me')
    expect(mine.headers.get('cache-control')).toBe('private, no-store')
    const anyone = await fetch(`${shellSite.origin}/`, { redirect: 'manual' })
    expect(anyone.status).toBe(200)
    // The Strata sample stage no longer leads the page (aba26768: that desktop UI was deleted) — the promo does.
    const front = await anyone.text()
    expect(front).not.toContain('class="strata"')
    expect(front).toContain('promo-poster')
    // No shell deployed: /me is the account page, so the front page stays the front page, with its promo.
    const mac = await claim(site.origin, 'yarrow')
    const noShell = await fetch(`${site.origin}/`, { headers: { authorization: `Bearer ${mac.token}` }, redirect: 'manual' })
    expect(noShell.status).toBe(200)
    const promo = await noShell.text()
    expect(promo).not.toContain('class="strata"')
    expect(promo).toContain('promo-poster')
  })

  it('with a shell but without --strata-me, /me and a signed-in / stay as they were', async () => {
    const mac = await claim(artSite.origin, 'rue')
    const front = await fetch(`${artSite.origin}/`, { headers: { authorization: `Bearer ${mac.token}` }, redirect: 'manual' })
    expect(front.status).toBe(200)
    const anyone = await (await fetch(`${artSite.origin}/`)).text()
    expect(anyone).not.toContain('class="strata"')
    for (const at of ['/me', '/me/m1/w1']) {
      const res = await fetch(`${artSite.origin}${at}`, { headers: { authorization: `Bearer ${mac.token}` } })
      const body = await res.text()
      expect(body, at).not.toContain('/strata/assets/index-')
    }
    const me = await fetch(`${artSite.origin}/me`, { headers: { authorization: `Bearer ${mac.token}` } })
    expect(me.status).toBe(200)
    expect(await me.text()).toContain('id="me-desktops"')
  })

  it('keeps /me the account page on a registry with no shell deployed', async () => {
    const mac = await claim(site.origin, 'tansy')
    const res = await fetch(`${site.origin}/me`, { headers: { authorization: `Bearer ${mac.token}` } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('id="me-desktops"')
    const account = await fetch(`${site.origin}/me/account`, { headers: { authorization: `Bearer ${mac.token}` } })
    expect(account.status).toBe(200)
  })

  it('serves the shell’s files from the second bundle, hashed ones immutable', async () => {
    const js = await fetch(`${shellSite.origin}/strata/assets/index-abc123.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(js.headers.get('cache-control')).toContain('immutable')
    const icon = await fetch(`${shellSite.origin}/strata/favicon.svg`)
    expect(icon.headers.get('cache-control')).toBe('public, max-age=300')
    expect((await fetch(`${shellSite.origin}/strata/assets/nope.js`)).status).toBe(404)
    expect((await fetch(`${shellSite.origin}/strata/toString`)).status).toBe(404)
    expect((await fetch(`${site.origin}/strata/assets/index-abc123.js`)).status).toBe(404)
  })

  it('refuses a bundle that is not one', () => {
    expect(readShellBundle('not json')).toBeNull()
    expect(readShellBundle(JSON.stringify({ version: 'v', index: 'x', files: { '../etc/passwd': { type: 't', body: 'b' } } }))).toBeNull()
    expect(readShellBundle(JSON.stringify({ version: 'v', index: 'x', files: { 'a.js': { body: 'b' } } }))).toBeNull()
    expect(loadShellBundle(path.join(dir, 'missing.json'))).toBeNull()
    expect(loadShellBundle(undefined)).toBeNull()
  })
})
