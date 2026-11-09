import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRegistry } from '../../registry/src/server'
import { RegistryStore } from '../../registry/src/store'
import { TransparencyLog } from '../../registry/src/log'
import { IdentityService } from '../../registry/src/identity'
import { DoorStore } from '../../registry/src/doors'
import { StarStore } from '../../registry/src/stars'
import { createV2 } from '../../registry/src/v2-routes'
import type { V2Identity } from '../../registry/src/v2-http'
import { deviceFromStored, type AccountDevice } from '../../src/renderer/src/account-device'
import type { Http } from '../../src/renderer/src/account-pair-client'
import { ed25519, type Pair } from './webauthn'

/**
 * A REAL REGISTRY AND THE ACCOUNTS ON IT, for the device-entry tests.
 *
 * Accounts are made in-process (the sign-in ladder has its own tests); what is
 * real is everything a grant touches: the router, the token key, /v2/keys, the
 * passkey checker, and a browser device key held the way site.js holds it.
 */

export const PASSWORD = 'correct horse battery staple'

export interface Browser {
  readonly device: AccountDevice
  readonly token: string
  readonly registry: Http
}

export interface GrantWorld {
  readonly origin: string
  readonly rpId: string
  readonly v2: V2Identity
  account(username: string, options?: { passwordless?: boolean }): Promise<void>
  /** A signed-in device; a phone unless said otherwise. */
  browser(username: string, kind?: 'phone' | 'watch' | 'desktop'): Promise<Browser>
  addPasskey(username: string): { pair: Pair; credentialId: Buffer }
  close(): Promise<void>
}

const jwkOf = async (key: CryptoKey): Promise<Record<string, string>> => {
  const full = (await crypto.subtle.exportKey('jwk', key)) as Record<string, string>
  return { kty: full.kty, crv: full.crv, x: full.x, y: full.y }
}

/** A browser device as site.js mints it: P-256, private half non-extractable. */
async function mintBrowserDevice(): Promise<{ id: string; jwk: Record<string, string>; device: AccountDevice }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as Record<string, string>
  const signing = await crypto.subtle.importKey('jwk', { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const jwk = await jwkOf(pair.publicKey)
  const id = randomUUID()
  const device = deviceFromStored({ id, name: 'iPhone', jwk, pair: { privateKey: signing } })
  if (device === null) throw new Error('the browser device did not read back')
  return { id, jwk, device }
}

export const httpWithBearer = (origin: string, token: string): Http => {
  const read = async (response: Response): Promise<{ status: number; body: unknown }> => {
    const text = await response.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return { status: response.status, body }
  }
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  return {
    get: async (p) => read(await fetch(`${origin}${p}`, { headers })),
    post: async (p, body) => read(await fetch(`${origin}${p}`, { method: 'POST', headers, body: JSON.stringify(body) }))
  }
}

export async function grantWorld(): Promise<GrantWorld> {
  const dir = mkdtempSync(path.join(tmpdir(), 'grant-world-'))
  const v2 = createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 } })
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const desktopJwk = (): Record<string, string> => ({ kty: 'OKP', crv: 'Ed25519', x: randomBytes(32).toString('base64url') })

  return {
    origin,
    rpId: '127.0.0.1',
    v2,
    account: async (username, options = {}) => {
      const device = { id: randomUUID(), kind: 'desktop', name: 'Solis', jwk: desktopJwk() }
      const made = options.passwordless
        ? v2.accounts.createWithProvider({ username, device, link: { provider: 'github', subject: randomUUID(), login: username, linkedAt: Date.now() }, email: null })
        : await v2.accounts.create({ username, password: PASSWORD, device })
      if (!made.ok) throw new Error(`could not make ${username}: ${made.reason}`)
    },
    browser: async (username, kind = 'phone') => {
      const minted = await mintBrowserDevice()
      const attached = v2.accounts.attachDevice(username, { id: minted.id, kind, name: kind === 'watch' ? 'Apple Watch' : kind === 'desktop' ? 'Solis-Core' : 'iPhone', jwk: minted.jwk }, { watch: kind === 'watch' })
      if (!attached.ok) throw new Error(attached.reason)
      // As a sign-in that just finished leaves it: proved, so fresh for five minutes.
      const session = v2.accounts.startSession(username, minted.id, { verifiedBy: 'passkey' })
      if (session === null) throw new Error('no session')
      const token = v2.tokens.mintSession(username, minted.id, session.jti).token
      return { device: minted.device, token, registry: httpWithBearer(origin, token) }
    },
    // Straight into the store: adding one over HTTP has its own tests (and,
    // for a passwordless account, a provider round trip this world has not got).
    addPasskey: (username) => {
      const pair = ed25519()
      const credentialId = randomBytes(20)
      const added = v2.factors.store.addPasskey(username, { credentialId: credentialId.toString('base64url'), jwk: pair.publicJwk, name: 'Face ID', signCount: 0 })
      if (!added.ok) throw new Error(added.reason)
      return { pair, credentialId }
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      })
  }
}
