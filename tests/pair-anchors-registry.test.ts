import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID, sign, createPrivateKey } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { pairAnchorsRoute } from '../registry/src/v2-pair-anchors'
import { Accounts, mintDeviceKey, writeAccount } from '../src/main/account-v2'
import { readAnchors } from '../src/main/pair-anchors'
import { ANCHORS_PATH, ANCHORS_PROOF_HEADER, anchorsProofMessage } from '../src/shared/account-pair'
import { fakeAccount } from './support/idv2'
import { ed25519, makeCredential } from './support/webauthn'

/**
 * THE ANCHORS, OVER THE REAL ROUTER AND THE REAL CLIENT.
 *
 * The machine reads the account's password record and passkeys from here and
 * checks an entry itself; this file proves who may read them (a desktop of the
 * account, with its bearer AND its key) and that what comes back is what the
 * machine's own checker accepts for the right password and refuses for a wrong one.
 */

const PASSWORD = 'correct horse battery staple'

interface Up {
  origin: string
  close: () => Promise<void>
}

async function up(): Promise<Up> {
  const dir = mkdtempSync(path.join(tmpdir(), 'pair-anchors-'))
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2: createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://127.0.0.1:${port}`,
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

let site: Up
beforeAll(async () => {
  site = await up()
})
afterAll(async () => {
  await site.close()
})

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${site.origin}${p}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })

let minted = 0
interface Desk {
  username: string
  deviceId: string
  token: string
  keys: ReturnType<typeof mintDeviceKey>
}

async function claimDesk(): Promise<Desk> {
  const username = `pairowner${++minted}`
  const keys = mintDeviceKey()
  const deviceId = randomUUID()
  const res = await call('POST', '/v2/accounts', {
    username,
    password: PASSWORD,
    device: { id: deviceId, kind: 'desktop', name: 'Solis', jwk: keys.publicKeyJwk }
  })
  expect(res.status).toBe(201)
  const out = (await res.json()) as { session: { token: string } }
  return { username, deviceId, token: out.session.token, keys }
}

const proofFor = (desk: Desk, at = Date.now()): string => {
  const key = createPrivateKey({ key: desk.keys.privateKeyJwk as never, format: 'jwk' })
  return `${at}.${sign(null, Buffer.from(anchorsProofMessage(desk.deviceId, at)), key).toString('base64url')}`
}

const anchorsAs = (desk: Desk, proof: string | null, token = desk.token): Promise<Response> =>
  call('GET', ANCHORS_PATH, undefined, {
    authorization: `Bearer ${token}`,
    ...(proof === null ? {} : { [ANCHORS_PROOF_HEADER]: proof })
  })

describe('GET /v2/me/pair-anchors', () => {
  it('answers a desktop that signs, and never with a password record', async () => {
    const desk = await claimDesk()
    const res = await anchorsAs(desk, proofFor(desk))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const anchors = readAnchors(await res.json(), desk.username)
    expect(anchors).not.toBeNull()
    expect(anchors?.rpId).toBe('127.0.0.1')
    expect(anchors?.devices.map((d) => d.id)).toEqual([desk.deviceId])
    expect(anchors?.locked).toBe(false)
    const raw = JSON.stringify(await (await anchorsAs(desk, proofFor(desk))).json())
    // No hash, no salt: a machine checks the password against its own verifier.
    expect(raw).not.toMatch(/"(hash|salt|password)"/)
  })

  it('a bearer alone reads nothing, nor a stale signature, nor one by another key', async () => {
    const desk = await claimDesk()
    expect((await anchorsAs(desk, null)).status).toBe(401)
    expect((await anchorsAs(desk, proofFor(desk, Date.now() - 10 * 60_000))).status).toBe(401)
    const other = { ...desk, keys: mintDeviceKey() }
    expect((await anchorsAs(desk, proofFor(other))).status).toBe(401)
  })

  it('a phone or a browser of the account may not read the password record', () => {
    for (const kind of ['phone', 'browser'] as const) {
      let status = 0
      const response = { writeHead: (code: number) => ((status = code), response), setHeader: () => undefined, end: () => undefined }
      const ctx = { request: { headers: {} }, response, v2: {} } as unknown as Parameters<typeof pairAnchorsRoute>[0]
      const signed = { account: {}, device: { id: randomUUID(), kind, jwk: {} } } as unknown as Parameters<typeof pairAnchorsRoute>[1]
      pairAnchorsRoute(ctx, signed)
      expect(status).toBe(403)
    }
  })

  it('lists the account passkeys with the keys a machine verifies against', async () => {
    const desk = await claimDesk()
    const pair = ed25519()
    const options = await call('POST', '/v2/me/passkeys/options', {}, { authorization: `Bearer ${desk.token}` })
    const { challenge } = (await options.json()) as { challenge: string }
    const credentialId = randomBytes(20)
    const credential = makeCredential({ pair, credentialId, challenge, origin: site.origin, rpId: '127.0.0.1' })
    const added = await call('POST', '/v2/me/passkeys', { name: 'Touch ID', credential }, { authorization: `Bearer ${desk.token}` })
    expect(added.status).toBe(201)
    const anchors = readAnchors(await (await anchorsAs(desk, proofFor(desk))).json(), desk.username)
    expect(anchors?.passkeys).toEqual([{ credentialId: credentialId.toString('base64url'), jwk: pair.publicJwk, signCount: 0 }])
  })

  it('is what the machine asks for: Accounts.pairAnchors signs with the account file', async () => {
    const desk = await claimDesk()
    const base = mkdtempSync(path.join(tmpdir(), 'pair-anchors-acct-'))
    try {
      writeAccount(
        fakeAccount({
          username: desk.username,
          deviceId: desk.deviceId,
          privateKeyJwk: desk.keys.privateKeyJwk,
          publicKeyJwk: desk.keys.publicKeyJwk,
          registry: site.origin,
          session: { token: desk.token, exp: Date.now() + 3_600_000 }
        }),
        base
      )
      const accounts = new Accounts({ base, origin: site.origin })
      const anchors = readAnchors(await accounts.pairAnchors(), desk.username)
      expect(anchors?.devices.map((d) => d.id)).toEqual([desk.deviceId])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
