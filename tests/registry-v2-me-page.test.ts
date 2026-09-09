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
import { ASSETS } from '../registry/src/assets-bundle'
import { canonicalJson } from '../registry/src/v2-reach'

/**
 * PHASE 2 — /me GROWS THE DESKTOP PICKER (M3).
 *
 * The markup is asserted because it is OURS: the CSP forbids an inline script,
 * so every state a reader can reach — probing, needs pairing, offline — has to
 * be in the page the server sent, with a script that only switches between
 * them. A picker assembled at load is a picker nobody can read in view-source
 * and nobody can style.
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
  const v2 = createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, helloPerMinute: 1000 } })
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

const mePage = async (): Promise<{ status: number; csp: string; html: string }> => {
  const res = await fetch(`${origin}/me`, { headers: { cookie: `__Host-cr_session=${session}` } })
  return {
    status: res.status,
    csp: res.headers.get('content-security-policy') ?? '',
    html: await res.text()
  }
}

describe('the DESKTOPS section', () => {
  it('lists the desktop, its workspaces and a probing badge', async () => {
    const { status, html } = await mePage()
    expect(status).toBe(200)
    expect(html).toContain('id="me-desktops"')
    expect(html).toContain(`data-desktop="${deviceId}"`)
    expect(html).toContain('MacBook Pro')
    expect(html).toContain('Cookrew Dev')
    expect(html).toContain('Playground')
    expect(html).toContain('PROBING')
  })

  it('names the three badges the script switches between, and no more', async () => {
    const { html } = await mePage()
    for (const badge of ['PROBING', 'ONLINE', 'OFFLINE']) expect(html).toContain(badge)
    for (const gone of ['LAN', 'TAILNET', 'RELAY', 'NEEDS PAIRING']) expect(html).not.toContain(gone)
  })

  /**
   * REACH v2.1. Pairing happens on the phone, on the companion's own "Not
   * paired" card, with the token the Mac prints. A row here that offered to
   * scan, to type six characters, to forget a key or to explain why the last
   * one was refused was a ceremony that no longer exists — and it put the
   * credential on the wrong device besides.
   */
  it('offers no pairing at all — no QR, no key field, no LINK, no refusals', async () => {
    const { html } = await mePage()
    for (const gone of [
      'SCAN QR',
      'TYPE KEY',
      'FORGET KEY',
      'data-scan=',
      'data-type-key=',
      'data-key-form=',
      'data-key-input=',
      'data-key-link=',
      'data-forget-pair=',
      'data-key-note',
      'data-refused-key',
      'data-refused-device',
      'reach-refused',
      'data-pair-note',
      'Pair a phone'
    ]) {
      expect(html, gone).not.toContain(gone)
    }
  })

  it('says nothing about a Mac but its name, its workspaces and where it lives here', async () => {
    const { html } = await mePage()
    // The addresses the Mac published are its own directory fact; the page no
    // longer probes them, so it no longer carries them either. They come back
    // in phase C3, as names a browser will trust.
    expect(html).not.toContain('data-reach="')
    expect(html).not.toContain('192.168.1.24')
    expect(html).not.toContain('mac.tail1234.ts.net')
  })

  /**
   * OPEN IS AN href IN THE MARKUP, so it works with the script broken, and it
   * carries nothing: no token, no key, no device. Opening a Mac from
   * cookrew.dev never leaves cookrew.dev.
   */
  it('opens the Mac at cookrew.dev\u2019s own relay prefix, with a bare query', async () => {
    const { html } = await mePage()
    expect(html).toContain(`href="/relay/@picker/desktop/${deviceId}/">OPEN</a>`)
    expect(html).not.toContain('?open=')
    expect(html).not.toContain('data-open-desktop')
  })
})

describe('the page stays inert', () => {
  it('has no inline script and loads reach.js from this origin', async () => {
    const { html, csp } = await mePage()
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/)
    expect(html).toContain('/assets/reach.js?v=')
    expect(html).toContain('/assets/device-id.js?v=')
    expect(csp).toContain("script-src 'self'")
  })

  it('keeps connect-src to this origin, because the page reaches nowhere else', async () => {
    const { csp } = await mePage()
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain('connect-src *')
    expect(csp).not.toContain('192.168.1.24')
  })

  it('bundles reach.js and device-id.js so the one file the registry is carries them', () => {
    expect(ASSETS['reach.js']?.type).toBe('text/javascript; charset=utf-8')
    expect(ASSETS['device-id.js']?.type).toBe('text/javascript; charset=utf-8')
    // The one question it asks, and the three it no longer does.
    expect(ASSETS['reach.js'].body).toContain('relay-status')
    expect(ASSETS['reach.js'].body).not.toContain('/api/hello')
    expect(ASSETS['reach.js'].body).not.toContain('cr_pair:')
    expect(ASSETS['reach.js'].body).not.toContain('cr_path:')
  })
})

describe('the relay path, when the Mac is holding no line (phase 3)', () => {
  it('answers 503 with a sentence and a way back, as a page', async () => {
    const res = await fetch(`${origin}/relay/@picker/desktop/${deviceId}/`, {
      headers: { cookie: `__Host-cr_session=${session}`, accept: 'text/html' }
    })
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Not reachable just now')
  })
})
