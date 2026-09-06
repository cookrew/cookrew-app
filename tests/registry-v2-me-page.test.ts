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
  const res = await fetch(`${origin}/me`, { headers: { cookie: `cr_session=${session}` } })
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

  it('carries the reach card the page will probe, and nothing else about the Mac', async () => {
    const { html } = await mePage()
    expect(html).toContain('data-reach="')
    expect(html).toContain('192.168.1.24')
    expect(html).toContain('mac.tail1234.ts.net')
  })

  it('names every badge the probe can land on, so the script only switches between them', async () => {
    const { html } = await mePage()
    for (const badge of ['LAN', 'TAILNET', 'RELAY', 'OFFLINE', 'PROBING', 'NEEDS PAIRING']) {
      expect(html).toContain(badge)
    }
  })
})

describe('the NEEDS PAIRING state', () => {
  it('is in the page the server sent, with both actions and the owner’s sentence', async () => {
    const { html } = await mePage()
    expect(html).toContain('NEEDS PAIRING')
    expect(html).toContain('Open the avatar on the Mac → Pair a phone. Then:')
    expect(html).toContain('SCAN QR')
    expect(html).toContain('TYPE KEY')
    expect(html).toContain('data-scan=')
    expect(html).toContain('data-type-key=')
    expect(html).toContain('data-open-desktop=')
  })

  it('carries the refusal sentence for a key the Mac did not take', async () => {
    const { html } = await mePage()
    expect(html).toContain('Not this Mac’s key — it changes every two minutes.')
  })

  it('carries the other refusal too — the link that named the Mac', async () => {
    const { html } = await mePage()
    expect(html).toContain('id="reach-refused-device"')
    expect(html).toContain('That link named the Mac, not the phone — open it again from cookrew.dev.')
  })

  it('gives each row its own copy of both refusals, so the sentence sits under its Mac', async () => {
    const { html } = await mePage()
    expect(html).toContain('data-refused-key')
    expect(html).toContain('data-refused-device')
  })

  it('ships OPEN disabled, because the server cannot know this browser holds a key', async () => {
    const { html } = await mePage()
    expect(html).toContain(`data-open-desktop="${deviceId}" hidden disabled`)
  })

  it('gives the six characters a field in the row rather than a native prompt', async () => {
    const { html } = await mePage()
    expect(html).toContain(`data-key-form="${deviceId}"`)
    expect(html).toContain(`data-key-input="${deviceId}"`)
    expect(html).toContain(`data-key-link="${deviceId}"`)
    expect(html).toContain('maxlength="6"')
    expect(html).toContain('Six characters, letters and digits — the ones shown beside the QR.')
  })

  it('names the device READING the page, which an admission has to carry', async () => {
    const { html } = await mePage()
    // From the SESSION, not from the row: whoever is reading is the device an
    // admission names, and here that happens to be the Mac itself. The picker
    // reads this attribute rather than the row's, which is the whole fix.
    expect(html).toContain(`id="me" data-username="picker"`)
    expect(html).toContain(`data-device="${deviceId}"`)
    expect(html).toContain('data-device-name="MacBook Pro"')
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

  it('opens connect-src to exactly the reach origins it will probe', async () => {
    const { csp } = await mePage()
    expect(csp).toContain('https://192.168.1.24:8643')
    expect(csp).toContain('https://mac.tail1234.ts.net:8643')
    expect(csp).not.toContain('connect-src *')
  })

  it('bundles reach.js and device-id.js so the one file the registry is carries them', () => {
    expect(ASSETS['reach.js']?.type).toBe('text/javascript; charset=utf-8')
    expect(ASSETS['device-id.js']?.type).toBe('text/javascript; charset=utf-8')
    expect(ASSETS['reach.js'].body).toContain('/api/hello')
    expect(ASSETS['reach.js'].body).toContain('cr_pair:')
    // Phase 3: the relay is asked about, and the winner is remembered.
    expect(ASSETS['reach.js'].body).toContain('relay-status')
    expect(ASSETS['reach.js'].body).toContain('cr_path:')
  })
})

describe('the relay path, when the Mac is holding no line (phase 3)', () => {
  it('answers 503 with a sentence and a way back, as a page', async () => {
    const res = await fetch(`${origin}/relay/@picker/desktop/${deviceId}/?open=x&key=ABCDEF`, {
      headers: { cookie: `cr_session=${session}`, accept: 'text/html' }
    })
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Not reachable just now')
  })
})
