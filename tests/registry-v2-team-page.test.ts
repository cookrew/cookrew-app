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
import { ASSETS } from '../registry/src/assets-bundle'

/**
 * A TEAM PAGE, BY WHAT THE REQUEST HOLDS (W2).
 *
 * The same address renders five ways: signed out, signed in with no seat,
 * seated, the owner's own view, and a team that charges nothing. It is decided
 * on the SERVER because the CSP forbids an inline script, and because a page
 * that arrived saying "buy a seat" and then changed its mind after a fetch is
 * a page that lied for a moment.
 */

const PASSWORD = 'correct horse battery staple'
const device = (name: string) => ({
  id: randomUUID(),
  kind: 'browser' as const,
  name,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

let dir = ''
let origin = ''
let close: () => Promise<void> = async () => undefined
const token: Record<string, string> = {}

const claim = async (username: string): Promise<string> => {
  const res = await fetch(`${origin}/v2/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD, device: device(username) })
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { session: { token: string } }).session.token
}

const read = (p: string, who?: string): Promise<string> =>
  fetch(`${origin}${p}`, { headers: who === undefined ? {} : { cookie: `cr_session=${who}` } }).then((r) => r.text())

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'v2-team-page-'))
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
  token.drej = await claim('drej')
  token.mira = await claim('mira')
  token.lin = await claim('lin')
  token.stranger = await claim('stranger')
  for (const username of ['mira', 'lin']) {
    const res = await fetch(`${origin}/v2/teams/@drej/alpha/seats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.drej}` },
      body: JSON.stringify({ username })
    })
    expect(res.status).toBe(201)
  }
})

afterAll(async () => {
  await close()
})

describe('signed out (401)', () => {
  it('offers the sheet and the reason a seat needs an account', async () => {
    const body = await read('/@drej/alpha')
    expect(body).toContain('Sign in to open')
    expect(body).toContain('data-signin')
    expect(body).toContain('A seat is yours, not a browser')
    expect(body).not.toContain('Buy a seat')
    expect(body).not.toContain('seated here')
  })
})

describe('signed in, no seat (403)', () => {
  it('offers the price and a copyable link that asks the owner', async () => {
    const body = await read('/@drej/alpha', token.stranger)
    expect(body).toContain('You are @stranger')
    expect(body).toContain('Buy a seat · $1')
    expect(body).toContain('Copy link to ask @drej')
    expect(body).toContain('https://cookrew.dev/@drej/alpha?ask=stranger')
    // No queue: the link is the whole mechanism.
    expect(body).not.toContain('Request a seat')
    expect(body).not.toContain('seated here')
  })
})

describe('seated', () => {
  it('opens the line and names who else is in the room', async () => {
    const body = await read('/@drej/alpha', token.mira)
    expect(body).toContain('Open the line')
    expect(body).toContain('seated here: @lin, @mira')
    expect(body).not.toContain('Buy a seat')
    expect(body).not.toContain('Copy link to ask')
  })

  it('says nothing about the owner’s devices or anyone’s receipt', async () => {
    const body = await read('/@drej/alpha', token.mira)
    expect(body).not.toContain('Grant a seat')
    expect(body).not.toContain('receipt')
  })
})

describe('the owner’s view', () => {
  it('counts the room, offers the grant form and ends a seat by its id', async () => {
    const body = await read('/@drej/alpha', token.drej)
    expect(body).toContain('Your team')
    expect(body).toContain('2 seated')
    expect(body).toContain('id="seat-username"')
    expect(body).toContain('Grant a seat')
    expect(body).toContain('data-seat-end=')
    expect(body).toContain('@mira')
    expect(body).toContain('granted by you')
    // No cap on a door face, so no free count is invented.
    expect(body).not.toContain('FREE')
  })

  it('prefills the grant form from the ask link the guest copied', async () => {
    const body = await read('/@drej/alpha?ask=stranger', token.drej)
    expect(body).toMatch(/id="seat-username"[^>]*value="stranger"/)
  })

  it('ignores an ask that is not a username, rather than echoing it', async () => {
    const body = await read('/@drej/alpha?ask=%3Cscript%3E', token.drej)
    expect(body).not.toContain('<script>alert')
    expect(body).toMatch(/id="seat-username"[^>]*value=""/)
  })

  it('is not shown to a guest who happens to be seated', async () => {
    const body = await read('/@drej/alpha', token.lin)
    expect(body).not.toContain('id="seat-username"')
  })
})

describe('a team that charges nothing', () => {
  it('still asks a stranger to sign in, then opens without a seat', async () => {
    const out = await read('/@drej/open-house')
    expect(out).toContain('Sign in to open')
    const inn = await read('/@drej/open-house', token.stranger)
    expect(inn).toContain('Open the line')
    expect(inn).not.toContain('Buy a seat')
    expect(inn).not.toContain('Copy link to ask')
  })
})

describe('the page itself', () => {
  it('carries no inline script — every state is server-rendered', async () => {
    for (const who of [undefined, token.stranger, token.mira, token.drej]) {
      const body = await read('/@drej/alpha', who)
      const scripts = body.match(/<script\b[^>]*>/g) ?? []
      expect(scripts.length).toBeGreaterThan(0)
      // Either a file from this origin, or the page's own JSON-LD, which is
      // data the CSP will not execute — never a line of behaviour in the page.
      for (const tag of scripts) expect(tag).toMatch(/\ssrc="|type="application\/ld\+json"/)
    }
  })

  it('is never cached, because it is rendered for one reader', async () => {
    const res = await fetch(`${origin}/@drej/alpha`, { headers: { cookie: `cr_session=${token.mira}` } })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('ships the seat verbs in the script the registry actually serves', () => {
    expect(ASSETS['site.js'].body).toContain('seat-grant')
    expect(ASSETS['site.js'].body).toContain('/seats')
    expect(ASSETS['site.js'].body).toContain('clipboard')
    expect(ASSETS['line.js'].body).toContain('/call-token')
  })
})
