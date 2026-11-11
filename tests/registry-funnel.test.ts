import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { createV2 } from '../registry/src/v2-routes'
import { FunnelCounts, funnelLimiterKey } from '../registry/src/funnel-counts'
import { createTelemetry } from '../src/main/telemetry'
import type { FunnelPayload } from '../src/shared/funnel-events'

/**
 * THE RECEIVER: takes only what the allowlist names, keeps only a day's sums,
 * and shows them to one account. Over the real router, with a real client.
 */

const PASSWORD = 'correct horse battery staple'
const INSTALL_ID = '3f2b8c1e-9d4a-4e7b-8a6f-0c1d2e3f4a5b'
const NOW = Date.UTC(2026, 10, 5, 13, 37, 42)

const payload = (over: Partial<FunnelPayload> = {}): FunnelPayload => ({
  event: 'installed',
  appVersion: '0.4.0',
  osFamily: 'mac',
  installId: INSTALL_ID,
  day: '2026-11-05',
  ...over
})

interface Site {
  origin: string
  dir: string
  counts: FunnelCounts
  close: () => Promise<void>
}

let dir = ''
let site: Site | null = null

async function up(
  options: {
    perMinute?: number
    owner?: string
    now?: () => number
    mounted?: boolean
    trustedProxies?: readonly string[]
    bodyMs?: number
  } = {}
): Promise<Site> {
  const now = options.now ?? ((): number => NOW)
  const counts = new FunnelCounts(dir, now)
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    v2: createV2(dir, { secondStep: 'legacy', limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } }),
    ...(options.mounted === false
      ? {}
      : {
          funnel: {
            counts,
            owner: options.owner ?? 'drej',
            perMinute: options.perMinute ?? 1000,
            ...(options.trustedProxies === undefined ? {} : { trustedProxies: options.trustedProxies }),
            ...(options.bodyMs === undefined ? {} : { bodyMs: options.bodyMs })
          }
        })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const made: Site = {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    dir,
    counts,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
  site = made
  return made
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'funnel-'))
})
afterEach(async () => {
  await site?.close()
  site = null
  rmSync(dir, { recursive: true, force: true })
})

const post = (at: Site, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): Promise<Response> =>
  fetch(`${at.origin}/v1/funnel`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

const device = () => ({
  id: randomUUID(),
  kind: 'desktop',
  name: 'This Mac',
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

/** A signed-in account's bearer, through the real sign-up route. */
const signIn = async (at: Site, username: string): Promise<string> => {
  const response = await fetch(`${at.origin}/v2/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD, device: device() })
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { session: { token: string } }).session.token
}

const read = (at: Site, token?: string): Promise<Response> =>
  fetch(`${at.origin}/v1/funnel`, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } })

interface Totals {
  totals: Record<string, number>
  days: { day: string; event: string; osFamily: string; appVersion: string; count: number }[]
}

describe('POST /v1/funnel', () => {
  it('takes a good event, answers with nothing, and adds one', async () => {
    const at = await up()
    const response = await post(at, payload())
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(at.counts.totals().totals.installed).toBe(1)
  })

  it('refuses a payload with anything extra, and counts nothing', async () => {
    const at = await up()
    for (const extra of ['prompt', 'path', 'username', 'email', 'repo', 'cardName', 'output']) {
      const response = await post(at, { ...payload(), [extra]: 'alice' })
      expect(response.status).toBe(400)
    }
    expect(at.counts.totals().totals.installed).toBe(0)
  })

  it('refuses an event nobody named', async () => {
    const at = await up()
    expect((await post(at, { ...payload(), event: 'prompt_sent' })).status).toBe(400)
  })

  it('refuses a body that is not JSON, and one that is too big', async () => {
    const at = await up()
    expect((await post(at, 'not json')).status).toBe(400)
    expect((await post(at, { pad: 'x'.repeat(4096) })).status).toBe(413)
  })

  it('refuses a form post, so a web page cannot spend its visitors to move the numbers', async () => {
    const at = await up()
    const response = await post(at, payload(), { 'content-type': 'text/plain' })
    expect(response.status).toBe(415)
    expect(at.counts.totals().totals.installed).toBe(0)
  })

  it('refuses a day outside the window: a stranger cannot write history or the future', async () => {
    const at = await up()
    expect((await post(at, payload({ day: '2026-11-06' }))).status).toBe(204)
    expect((await post(at, payload({ day: '2026-10-06' }))).status).toBe(204)
    expect((await post(at, payload({ day: '2026-11-07' }))).status).toBe(400)
    expect((await post(at, payload({ day: '2026-10-05' }))).status).toBe(400)
    expect((await post(at, payload({ day: '2021-01-01' }))).status).toBe(400)
  })

  it('is rate limited, and the refusal costs the count', async () => {
    const at = await up({ perMinute: 2 })
    expect((await post(at, payload())).status).toBe(204)
    expect((await post(at, payload())).status).toBe(204)
    expect((await post(at, payload())).status).toBe(429)
    expect(at.counts.totals().totals.installed).toBe(2)
  })

  it('behind a named proxy each caller has its own budget', async () => {
    const at = await up({ perMinute: 1, trustedProxies: ['127.0.0.1'] })
    const from = (address: string): Promise<Response> =>
      post(at, payload(), { 'content-type': 'application/json', 'x-forwarded-for': address })
    expect((await from('203.0.113.1')).status).toBe(204)
    expect((await from('203.0.113.1')).status).toBe(429)
    expect((await from('203.0.113.2')).status).toBe(204)
  })

  it('with no proxy named, a forged header buys no fresh budget', async () => {
    const at = await up({ perMinute: 1 })
    const from = (address: string): Promise<Response> =>
      post(at, payload(), { 'content-type': 'application/json', 'x-forwarded-for': address })
    expect((await from('203.0.113.1')).status).toBe(204)
    expect((await from('203.0.113.2')).status).toBe(429)
  })

  it('a body that never arrives does not hold the socket', async () => {
    const at = await up({ bodyMs: 100 })
    const socket = connect(Number(new URL(at.origin).port), '127.0.0.1')
    socket.on('error', () => undefined)
    socket.write('POST /v1/funnel HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n')
    const closed = await new Promise<boolean>((resolve) => {
      const giveUp = setTimeout(() => resolve(false), 3_000)
      socket.on('close', () => {
        clearTimeout(giveUp)
        resolve(true)
      })
    })
    socket.destroy()
    expect(closed).toBe(true)
  })

  it('does not exist on a registry that did not mount it', async () => {
    const at = await up({ mounted: false })
    expect((await post(at, payload())).status).toBe(404)
  })
})

describe('what is kept', () => {
  it('daily sums by event, OS family and version: nothing per install', async () => {
    const at = await up()
    await post(at, payload())
    await post(at, payload({ installId: randomUUID() }))
    await post(at, payload({ osFamily: 'windows' }))
    await post(at, payload({ event: 'paid', appVersion: '0.5.0' }))
    await at.counts.flush()
    expect(JSON.parse(readFileSync(path.join(dir, 'funnel.json'), 'utf8'))).toEqual({
      '2026-11-05': { 'installed|mac|0.4.0': 2, 'installed|windows|0.4.0': 1, 'paid|mac|0.5.0': 1 }
    })
  })

  it('NEVER: no install id and no address reaches any file the registry owns', async () => {
    const at = await up()
    await post(at, payload())
    await at.counts.flush()
    const walk = (at2: string): string[] =>
      readdirSync(at2).flatMap((name) => {
        const full = path.join(at2, name)
        return statSync(full).isDirectory() ? walk(full) : [full]
      })
    for (const file of walk(dir)) {
      const text = readFileSync(file).toString('latin1')
      expect(text).not.toContain(INSTALL_ID)
      expect(text).not.toContain('127.0.0.1')
    }
  })

  it('the limiter holds a keyed digest of an address, never the address', () => {
    const key = funnelLimiterKey('203.0.113.9')
    expect(key).not.toContain('203.0.113.9')
    expect(funnelLimiterKey('203.0.113.9')).toBe(key)
    expect(funnelLimiterKey('203.0.113.10')).not.toBe(key)
  })

  it('a directory it cannot write loses the count and never spins the process', async () => {
    writeFileSync(path.join(dir, 'a-file'), 'not a directory')
    const counts = new FunnelCounts(path.join(dir, 'a-file', 'data'), () => NOW)
    counts.add(payload())
    await counts.flush()
    counts.add(payload())
    await counts.flush()
    expect(counts.totals().totals.installed).toBe(2)
  })

  it('survives a restart', async () => {
    const at = await up()
    await post(at, payload())
    await at.counts.flush()
    expect(new FunnelCounts(dir, () => NOW).totals().totals.installed).toBe(1)
  })

  it('a stranger cannot grow the file by inventing versions', () => {
    const counts = new FunnelCounts(dir, () => NOW)
    for (let minor = 0; minor < 800; minor += 1) counts.add(payload({ appVersion: `0.${minor}.0` }))
    expect(counts.totals().days.length).toBeLessThanOrEqual(500)
  })

  it('a torn file reads as empty and never takes the registry down', async () => {
    writeFileSync(path.join(dir, 'funnel.json'), '{"2026-11-05":{"installed|mac')
    expect(new FunnelCounts(dir, () => NOW).totals().totals.installed).toBe(0)
    writeFileSync(path.join(dir, 'funnel.json'), JSON.stringify({ '2026-11-05': { 'prompt_sent|mac|0.4.0': 9, 'paid|mac|0.4.0': 'x' } }))
    expect(new FunnelCounts(dir, () => NOW).totals().days).toEqual([])
  })

  it('older than the retention is dropped on write', async () => {
    let now = NOW
    const counts = new FunnelCounts(dir, () => now)
    counts.add(payload())
    await counts.flush()
    now = NOW + 500 * 86_400_000
    counts.add(payload({ day: '2028-03-19' }))
    await counts.flush()
    expect(Object.keys(JSON.parse(readFileSync(path.join(dir, 'funnel.json'), 'utf8')) as object)).toEqual(['2028-03-19'])
  })
})

describe('GET /v1/funnel', () => {
  it('answers the owner with totals and days, private and uncached', async () => {
    const at = await up({ owner: 'drej' })
    const token = await signIn(at, 'drej')
    await post(at, payload())
    await post(at, payload({ event: 'paid' }))
    const response = await read(at, token)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const body = (await response.json()) as Totals
    expect(body.totals).toEqual({ installed: 1, preflight_passed: 0, first_turn_done: 0, phone_paired: 0, paid: 1 })
    expect(body.days).toContainEqual({ day: '2026-11-05', event: 'paid', osFamily: 'mac', appVersion: '0.4.0', count: 1 })
  })

  it('401 to nobody, 403 to anybody else', async () => {
    const at = await up({ owner: 'drej' })
    expect((await read(at)).status).toBe(401)
    expect((await read(at, 'not-a-token')).status).toBe(401)
    expect((await read(at, await signIn(at, 'mallory'))).status).toBe(403)
  })

  it('with no owner configured it is closed to everyone', async () => {
    const at = await up({ owner: '' })
    expect((await read(at, await signIn(at, 'drej'))).status).toBe(404)
  })

  it('a registry without v2 cannot answer it at all', async () => {
    const counts = new FunnelCounts(dir, () => NOW)
    const server = createRegistry({
      store: new RegistryStore(dir),
      log: new TransparencyLog(dir),
      funnel: { counts, owner: 'drej' }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const response = await fetch(`${origin}/v1/funnel`)
    expect(response.status).toBe(404)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

describe('end to end: the real client against the real route', () => {
  it('lands, once, and the owner reads it', async () => {
    const at = await up({ owner: 'drej', now: () => Date.now() })
    const base = mkdtempSync(path.join(tmpdir(), 'funnel-client-'))
    try {
      const telemetry = createTelemetry({
        appVersion: '0.4.0',
        base,
        env: {},
        platform: 'darwin',
        origin: () => at.origin,
        fetch: (url, init) => fetch(url, init)
      })
      telemetry.setOn(true)
      telemetry.emit('installed')
      telemetry.emit('installed')
      telemetry.emit('phone_paired')
      await telemetry.settled()
      const body = (await (await read(at, await signIn(at, 'drej'))).json()) as Totals
      expect(body.totals.installed).toBe(1)
      expect(body.totals.phone_paired).toBe(1)
      expect(JSON.parse(readFileSync(path.join(base, 'telemetry.json'), 'utf8')).events.installed.status).toBe('sent')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
