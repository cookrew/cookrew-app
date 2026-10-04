// GET /v2/names/<host> — THE NAME ORACLE, FOR A PHONE THAT CANNOT SEE DNS.
//
// A browser's fetch failure has no cause attached. The companion used to read
// a TypeError under 50 ms as "the browser refused before connecting", and on
// 2026-10-04 that sentence sat over five days of NXDOMAIN: the owner's Mac had
// stopped publishing its card, the zone had forgotten its names, and the
// phone's resolver answered "no such name" from cache in 4 ms. The zone knows
// the truth and this route says it over HTTPS, which every page can reach.
//
// Public and unauthenticated on purpose — it reveals nothing the zone does not
// already answer to anyone with `dig` — and rate limited like verify-hello.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import type { NamesFeature } from '../registry/src/names'

const ZONE = 'd.cookrew.dev'
const DEVICE = 'e03994f9-138d-80ff-9377-475cc59142b4'
const LIVE = `192-168-0-105.${DEVICE}.${ZONE}`

const up = async (names: NamesFeature | null): Promise<{ origin: string; close: () => Promise<void>; dir: string }> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-names-'))
  const v2 = createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, helloPerMinute: 5 } })
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2,
    ...(names === null ? {} : { names })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    dir,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** The names half as the route sees it: one zone, one question answered. */
const names = (): NamesFeature =>
  ({
    zone: ZONE,
    lookup: (host: string) => (host === LIVE ? { live: true, address: '192.168.0.105' } : { live: false }),
    respond: () => {
      throw new Error('not over the wire here')
    },
    wildcardFor: () => '',
    hasNames: () => true,
    state: () => ({ status: 'none' }),
    request: () => ({ ok: false, code: 400, error: 'bad_csr' })
  }) as unknown as NamesFeature

describe('GET /v2/names/<host>', () => {
  let site: Awaited<ReturnType<typeof up>>
  beforeAll(async () => {
    site = await up(names())
  })
  afterAll(async () => {
    await site.close()
    rmSync(site.dir, { recursive: true, force: true })
  })

  it('answers live for a name the zone is answering, and never caches it', async () => {
    const response = await fetch(`${site.origin}/v2/names/${LIVE}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toEqual({ live: true })
  })

  it('answers dead for a name it is not — same status, so the phone can tell "no" from "could not ask"', async () => {
    const response = await fetch(`${site.origin}/v2/names/10-0-0-9.${DEVICE}.${ZONE}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ live: false })
  })

  it('refuses a host that is not under the zone, or is not a hostname at all', async () => {
    for (const host of ['example.com', `${'a'.repeat(300)}.${ZONE}`, 'not a host', encodeURIComponent('x/y')]) {
      const response = await fetch(`${site.origin}/v2/names/${host}`)
      expect(response.status, host.slice(0, 20)).toBe(400)
    }
  })

  it('is rate limited per caller like verify-hello', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 8; i++) statuses.push((await fetch(`${site.origin}/v2/names/${LIVE}`)).status)
    expect(statuses).toContain(429)
  })
})

describe('a registry with no names half', () => {
  it('answers 404, which the phone reads as "could not ask", never as dead', async () => {
    const site = await up(null)
    try {
      const response = await fetch(`${site.origin}/v2/names/${LIVE}`)
      expect(response.status).toBe(404)
    } finally {
      await site.close()
      rmSync(site.dir, { recursive: true, force: true })
    }
  })
})
