import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService, type IdentityConfig } from '../registry/src/identity'
import { jwkThumbprint as registryThumbprint } from '../registry/src/jwk'
import { mintAccount, openAccount, type AccountSession } from '../src/main/account'
import { bindPairedDevice } from '../src/main/pair-device'
import { buildRegistryAssertion, jwkThumbprint as appThumbprint } from '../src/main/registry-assertion'
import { createRegistryTokenVerifier, registryKeyOverHttp } from '../src/main/registry-token'

/**
 * THE TWO HALVES OF ONE IDENTITY, END TO END.
 *
 * The registry (accounts, devices, tokens) and the app (the account file, the
 * door's verifier, the phone's binding at pairing) were built against one
 * written contract. A contract is a promise; this is the receipt. A REAL
 * registry listens on a port and the app's own code talks to it over HTTP:
 * mint the account, mint a call token, verify it at a door, bind a phone,
 * let the phone sign for the account, revoke it, watch the door refuse it.
 */

const HANDLE = 'drej'
const DOOR = '@drej/cookrew-alpha'

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

let base = ''
let home = ''
let url = ''
let close: () => void = () => {}

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'identity-e2e-registry-'))
  home = mkdtempSync(path.join(tmpdir(), 'identity-e2e-home-'))
  const port = await freePort()
  url = `http://127.0.0.1:${port}`
  const config: IdentityConfig = {
    rpId: '127.0.0.1',
    origin: url,
    tokenTtlMs: 10 * 60 * 1000,
    challengeTtlMs: 90 * 1000,
    linkTtlMs: 2 * 60 * 1000
  }
  const identity = new IdentityService(base, config)
  const server = createRegistry({
    store: new RegistryStore(base),
    log: new TransparencyLog(base),
    identity
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  close = () => server.close()
})

afterEach(() => {
  close()
  rmSync(base, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

async function mintedSession(): Promise<AccountSession> {
  const account = await mintAccount({ handle: HANDLE, registry: url, baseDir: home })
  return openAccount(account, { baseDir: home })
}

describe('the app and the registry agree on one account', () => {
  it('mints the account, and the handle is taken from then on', async () => {
    const session = await mintedSession()
    expect(session.handle).toBe(HANDLE)
    expect((await fetch(`${url}/v1/accounts/${HANDLE}`, { method: 'HEAD' })).status).toBe(200)
    expect((await fetch(`${url}/v1/accounts/nobody`, { method: 'HEAD' })).status).toBe(404)
    await expect(mintAccount({ handle: HANDLE, registry: url, baseDir: home })).rejects.toThrow()
    const devices = await session.listDevices()
    expect(devices.map((d) => [d.kind, d.id])).toEqual([['desktop', session.deviceId]])
  })

  it('a call token minted by the account opens the door it names and no other', async () => {
    const session = await mintedSession()
    const token = await session.token('call', DOOR)
    const door = createRegistryTokenVerifier({ keys: registryKeyOverHttp(url) })
    expect(await door.verify(token, DOOR)).toEqual({ sub: HANDLE, dev: session.deviceId })
    expect(await door.verify(token, '@drej/other-team')).toBeNull()
    // An account token is not a call token: the door refuses the scope.
    expect(await door.verify(await session.token('account'), DOOR)).toBeNull()
  })

  it('the thumbprint both sides name a device by is the same bytes', () => {
    const okp = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
      format: 'jwk'
    }) as Record<string, unknown>
    expect(appThumbprint(okp)).toBe(registryThumbprint(okp))
    expect(appThumbprint(ec)).toBe(registryThumbprint(ec))
  })
})

describe('the phone is a device of the account, bound at pairing', () => {
  it('binds, signs for the account, is revoked, and the door refuses it', async () => {
    const session = await mintedSession()
    const phone = generateKeyPairSync('ed25519')
    const phoneJwk = phone.publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    const phoneId = randomUUID()

    // The desktop route the phone posts to at pairing, with the account behind it.
    const bound = await bindPairedDevice(
      { id: phoneId, jwk: phoneJwk, kind: 'phone', name: 'iPhone' },
      () => session
    )
    expect(bound.status).toBe(200)
    expect(bound.body).toEqual({ handle: HANDLE, deviceId: phoneId })
    expect((await session.listDevices()).map((d) => d.kind).sort()).toEqual(['desktop', 'phone'])

    // The phone now signs for the account with ITS key: challenge → assert.
    const challenged = await fetch(`${url}/v1/identity/challenge`, { method: 'POST', body: '{}' })
    const { challenge } = (await challenged.json()) as { challenge: string }
    const assertion = buildRegistryAssertion({
      origin: url,
      credentialId: HANDLE,
      privateKeyJwk: phone.privateKey.export({ format: 'jwk' }) as Record<string, unknown>,
      challenge
    })
    const asserted = await fetch(`${url}/v1/identity/assert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...assertion, scope: 'call', aud: DOOR, device: phoneId })
    })
    expect(asserted.status).toBe(200)
    const { token } = (await asserted.json()) as { token: string }
    const door = createRegistryTokenVerifier({ keys: registryKeyOverHttp(url) })
    expect(await door.verify(token, DOOR)).toEqual({ sub: HANDLE, dev: phoneId })

    // Revoked from the desktop: the token it already holds stops opening doors.
    expect(await session.revokeDevice(phoneId)).toBe(true)
    const afterRevoke = createRegistryTokenVerifier({ keys: registryKeyOverHttp(url) })
    expect(await afterRevoke.verify(token, DOOR)).toBeNull()
    // And it can no longer sign for the account at all.
    const again = await fetch(`${url}/v1/identity/challenge`, { method: 'POST', body: '{}' })
    const next = (await again.json()) as { challenge: string }
    const refused = await fetch(`${url}/v1/identity/assert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...buildRegistryAssertion({
          origin: url,
          credentialId: HANDLE,
          privateKeyJwk: phone.privateKey.export({ format: 'jwk' }) as Record<string, unknown>,
          challenge: next.challenge
        }),
        scope: 'call',
        aud: DOOR,
        device: phoneId
      })
    })
    expect(refused.status).toBe(401)
  })

  it('a link code from the desktop binds a browser with no other ceremony', async () => {
    const session = await mintedSession()
    const { code } = await session.linkCode()
    expect(code).toMatch(/^[A-Z0-9]{6}$/)
    const browser = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' })
    const linked = await fetch(`${url}/v1/accounts/${HANDLE}/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        device: { id: randomUUID(), jwk: browser, kind: 'browser', name: 'Chrome' }
      })
    })
    expect(linked.status).toBe(201)
    expect((await session.listDevices()).map((d) => d.kind).sort()).toEqual(['browser', 'desktop'])
    // Single use.
    const replay = await fetch(`${url}/v1/accounts/${HANDLE}/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        device: { id: randomUUID(), jwk: browser, kind: 'browser', name: 'Again' }
      })
    })
    expect([404, 410]).toContain(replay.status)
  })
})
