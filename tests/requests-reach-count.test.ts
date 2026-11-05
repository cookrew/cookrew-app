// BOX ROUND 3, BUG 9. The avatar's count showed a sign-in and not a Wi-Fi ask, so
// a phone could wait on ALLOW unseen. Every link is real here but the window: a
// loopback registry, the desktop's queue on its own wire, and the avatar's view.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdentityService } from '../registry/src/identity'
import { TransparencyLog } from '../registry/src/log'
import { createRegistry } from '../registry/src/server'
import { StarStore } from '../registry/src/stars'
import { RegistryStore } from '../registry/src/store'
import { createV2 } from '../registry/src/v2-routes'
import { Requests, type RequestsCaller } from '../src/main/requests'
import { avatarView } from '../src/renderer/src/account/account-store'
import type { AccountStatus } from '../src/shared/account-v2'
import { loopbackOnly } from './support/pay-gate-fixture'

const PASSWORD = 'correct horse battery staple'
const JWK = { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }

let dir = ''
let origin = ''
let server: Server

const send = (method: string, route: string, body?: unknown, token?: string): Promise<Response> =>
  fetch(`${origin}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'reach-count-'))
  server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    stars: new StarStore(dir),
    v2: createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = loopbackOnly(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  rmSync(dir, { recursive: true, force: true })
})

async function desktopAndPhone(): Promise<{ desktop: string; desktopId: string; phone: string }> {
  const desktopId = randomUUID()
  const claimed = await send('POST', '/v2/accounts', {
    username: 'mira', password: PASSWORD, device: { id: desktopId, kind: 'desktop', name: 'Linux · box', jwk: JWK }
  })
  expect(claimed.status).toBe(201)
  const desktop = ((await claimed.json()) as { session: { token: string } }).session.token
  expect((await send('PUT', `/v2/me/desktops/${desktopId}`, { name: 'Linux · box', workspaces: [] }, desktop)).status).toBeLessThan(300)
  const { code } = (await (await send('POST', '/v2/me/join-codes', { current: PASSWORD }, desktop)).json()) as { code: string }
  const joined = await send('POST', '/v2/join', { code, device: { id: randomUUID(), kind: 'phone', name: 'Pixel', jwk: JWK } })
  expect(joined.status).toBe(201)
  return { desktop, desktopId, phone: ((await joined.json()) as { token: string }).token }
}

function queueOf(token: string): { requests: Requests; changes: () => number } {
  let changes = 0
  const caller = {
    account: () => ({ username: 'mira' }),
    sessionLive: () => true,
    call: async (pathname: string) => {
      const res = await send('GET', pathname, undefined, token)
      return res.ok ? { ok: true, value: await res.json() } : { ok: false, reason: 'offline' }
    }
  } as unknown as RequestsCaller
  const requests = new Requests({
    accounts: caller as never,
    notify: () => undefined,
    onChange: () => {
      changes += 1
    }
  })
  return { requests, changes: () => changes }
}

const status = (requests: number): AccountStatus => ({ username: 'mira', displayName: '', avatar: null, requests }) as AccountStatus

describe('a phone asking for Wi-Fi', () => {
  it('reaches the avatar’s count on the desktop it asked', async () => {
    const { desktop, desktopId, phone } = await desktopAndPhone()
    const { requests, changes } = queueOf(desktop)
    await requests.refresh()
    expect(requests.count).toBe(0)
    expect((await send('POST', `/v2/me/desktops/${desktopId}/reach-requests`, {}, phone)).status).toBe(201)
    await requests.refresh()
    expect(requests.list().map((row) => row.kind)).toEqual(['reach'])
    expect(requests.count).toBe(1)
    expect(changes()).toBe(1)
    expect(avatarView(status(requests.count)).badge).toBe(1)
  })

  it('says what is waiting, not a device signing in', () => {
    expect(avatarView(status(1)).title).toBe('@mira — 1 request waiting')
    expect(avatarView(status(2)).title).toBe('@mira — 2 requests waiting')
  })
})
