import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccountPairDoor } from '../src/main/account-pair'
import { handleAccountPairRoutes } from '../src/main/account-pair-routes'
import { createAdmittedDeviceStore, type AdmittedDeviceStore } from '../src/main/admitted-devices'
import type { PairAnchors } from '../src/main/pair-anchors'
import { unlockVerifierFor } from '../src/main/account-v2'
import { memoryPins } from '../src/main/account-pair-pins'
import { deviceFromStored, type AccountDevice } from '../src/renderer/src/account-device'
import { browserPairDeps, enterWithAccount, pairOffer, type PairClientDeps } from '../src/renderer/src/account-pair-client'
import { fakeAccount, tempBase } from './support/idv2'
import { b64u, ed25519, getAssertion, GET_FLAGS_VERIFIED, type Pair } from './support/webauthn'

/**
 * THE PHONE'S HALF, AGAINST THE MACHINE'S HALF, OVER HTTP.
 *
 * The browser code runs in node with node's WebCrypto: a non-extractable P-256
 * key stored the way site.js stores it, the password sealed by the same
 * function the page uses, and a passkey answered by a fake authenticator that
 * signs for real. The server is the machine's own route handler and door.
 */

const PASSWORD = 'correct horse battery staple'
const RP_ID = 'cookrew.dev'
const CREDENTIAL = Buffer.from('passkey-credential-2')

/** A browser device as site.js leaves it in IndexedDB, read back by account-device.ts. */
async function browserDevice(): Promise<AccountDevice> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const full = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, string>
  const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as Record<string, string>
  const signing = await crypto.subtle.importKey('jwk', { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const device = deviceFromStored({
    id: crypto.randomUUID(),
    name: 'iPhone',
    jwk: { kty: full.kty, crv: full.crv, x: full.x, y: full.y },
    pair: { privateKey: signing }
  })
  if (device === null) throw new Error('the stored device did not read back')
  return device
}

/** navigator.credentials.get, answered by a real signature over the asked challenge. */
const authenticator = (passkey: Pair, origin: string) => async (options: CredentialRequestOptions): Promise<Credential> => {
  const asked = options.publicKey!
  const challenge = b64u(new Uint8Array(asked.challenge as ArrayBuffer))
  const made = getAssertion({ pair: passkey, credentialId: CREDENTIAL, challenge, origin, rpId: asked.rpId!, flags: GET_FLAGS_VERIFIED })
  const bytes = (text: string): ArrayBuffer => new Uint8Array(Buffer.from(text, 'base64url')).buffer
  return {
    id: made.id,
    type: 'public-key',
    response: {
      clientDataJSON: bytes(made.response.clientDataJSON),
      authenticatorData: bytes(made.response.authenticatorData),
      signature: bytes(made.response.signature)
    }
  } as unknown as Credential
}

describe('entering a machine from the phone', () => {
  let temp: { base: string; clean: () => void }
  let admitted: AdmittedDeviceStore
  let server: http.Server
  let base: string
  let anchors: PairAnchors
  let passkey: Pair
  let device: AccountDevice
  const account = fakeAccount({ username: 'anvztor' })
  const verifier = unlockVerifierFor(PASSWORD)

  beforeEach(async () => {
    temp = tempBase()
    admitted = createAdmittedDeviceStore({ base: temp.base })
    passkey = ed25519()
    device = await browserDevice()
    anchors = {
      username: 'anvztor',
      rpId: RP_ID,
      locked: false,
      passkeys: [{ credentialId: b64u(CREDENTIAL), jwk: passkey.publicJwk, signCount: 0 }],
      devices: [{ id: device.id, jwk: device.jwk }]
    }
    const door = createAccountPairDoor({
      account: () => account,
      anchors: async () => anchors,
      localPassword: () => verifier,
      pins: memoryPins(),
      admitted,
      origins: () => [base],
      platform: 'linux'
    })
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://x')
      void handleAccountPairRoutes(request, response, url, door, null).then((handled) => {
        if (!handled) {
          response.writeHead(404)
          response.end()
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    temp.clean()
  })

  const deps = (over: Partial<PairClientDeps> = {}): PairClientDeps => ({
    ...browserPairDeps(base, async () => device),
    passkey: authenticator(passkey, base),
    ...over
  })

  it('reads the offer, with the machine’s platform for its sentences', async () => {
    expect(await pairOffer(deps())).toEqual({ offered: true, reachable: true, desktopId: account.deviceId, platform: 'linux', methods: ['password', 'passkey'] })
  })

  it('enters with the password and comes back with a token this machine takes', async () => {
    const result = await enterWithAccount(deps(), PASSWORD)
    expect(result.kind).toBe('entered')
    if (result.kind !== 'entered') return
    expect(result.desktopId).toBe(account.deviceId)
    expect(admitted.deviceFor(result.token)).toBe(device.id)
  })

  it('enters with a passkey', async () => {
    const result = await enterWithAccount(deps(), null)
    expect(result.kind).toBe('entered')
    expect(admitted.list()[0]).toMatchObject({ deviceId: device.id, via: 'passkey' })
  })

  it('says how many tries are left after a wrong password', async () => {
    const result = await enterWithAccount(deps(), 'not the password at all')
    expect(result).toMatchObject({ kind: 'refused', triesLeft: 2 })
    expect(admitted.list()).toEqual([])
  })

  it('a browser that never signed in to cookrew.dev is told so, and nothing is asked of the machine', async () => {
    let asked = 0
    const result = await enterWithAccount({ ...deps(), device: async () => null, post: async () => ((asked += 1), { status: 500, body: null }) }, PASSWORD)
    expect(result).toEqual({ kind: 'no-device' })
    expect(asked).toBe(0)
  })

  it('a passkey sheet the person closed spends no try', async () => {
    const cancelled = await enterWithAccount(deps({ passkey: async () => Promise.reject(new DOMException('closed', 'NotAllowedError')) }), null)
    expect(cancelled).toEqual({ kind: 'cancelled' })
    const next = await enterWithAccount(deps(), 'a wrong password once')
    expect(next).toMatchObject({ kind: 'refused', triesLeft: 2 })
  })

  it('the request body carries no password in clear', async () => {
    const seen: string[] = []
    const real = deps()
    const spying: PairClientDeps = { ...real, post: async (path, body) => (seen.push(JSON.stringify(body)), real.post(path, body)) }
    await enterWithAccount(spying, PASSWORD)
    expect(seen.join('\n')).not.toContain(PASSWORD)
  })

  it('a passkey request this browser cannot read is said, not taken for a closed sheet', async () => {
    const real = deps()
    const broken: PairClientDeps = {
      ...real,
      post: async (path, body) => {
        const out = await real.post(path, body)
        return path.endsWith('/begin') ? { ...out, body: { ...(out.body as object), passkey: { rpId: RP_ID, challenge: '%%%', allow: [] } } } : out
      }
    }
    expect((await enterWithAccount(broken, null)).kind).toBe('failed')
  })
})
