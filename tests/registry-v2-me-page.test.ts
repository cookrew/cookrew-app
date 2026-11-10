import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { canonicalJson } from '../registry/src/v2-reach'

/**
 * WHAT /me's DESKTOP PICKER LEFT BEHIND (M3).
 *
 * The page and its script are gone (0.6.0: the machines are the console's;
 * tests/registry-no-site.test.ts holds that /me answers nothing). What the
 * picker opened is still here and still the registry's: the one relay path of
 * an account's own machine, as data.
 */

const PASSWORD = 'correct horse battery staple'
const CERT = 'b'.repeat(64)

let origin = ''
let close: () => Promise<void> = async () => undefined
let session = ''
let deviceId = ''

const pair = generateKeyPairSync('ed25519')

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-me-page-'))
  const v2 = createV2(dir, { secondStep: 'legacy', limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, helloPerMinute: 1000 } })
  const server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
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

  deviceId = randomUUID()
  const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>
  const claimed = await fetch(`${origin}/v2/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'picker',
      password: PASSWORD,
      device: { id: deviceId, kind: 'desktop', name: 'MacBook Pro', jwk }
    })
  })
  session = ((await claimed.json()) as { session: { token: string } }).session.token

  const reach = {
    lan: [{ url: 'https://192.168.1.24:8643', certFp: CERT }],
    tailnet: { url: 'https://mac.tail1234.ts.net:8643', certFp: CERT },
    relay: true,
    at: new Date().toISOString()
  }
  const sig = sign(null, Buffer.from(canonicalJson({ deviceId, ...reach }), 'utf8'), pair.privateKey).toString(
    'base64url'
  )
  await fetch(`${origin}/v2/me/desktops/${deviceId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'MacBook Pro',
      workspaces: [
        { id: 'w1', name: 'Cookrew Dev' },
        { id: 'w2', name: 'Playground' }
      ],
      reach,
      sig
    })
  })
})
afterAll(async () => {
  await close()
})

describe('the relay path, when the Mac is holding no line', () => {
  it('answers 503 with a sentence, as data: the relay carries no page', async () => {
    const res = await fetch(`${origin}/api/m/${deviceId}/api/fleet`, {
      headers: { 'x-cookrew-session': session, accept: 'text/html' }
    })
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('no_link')
    expect(body.message).toMatch(/[.!]$/)
  })

  it('answers nothing at the old per-machine page address', async () => {
    const res = await fetch(`${origin}/relay/@picker/desktop/${deviceId}/`, {
      headers: { cookie: `__Host-cr_session=${session}`, accept: 'text/html' }
    })
    expect(res.status).toBe(404)
    await res.arrayBuffer()
  })
})
