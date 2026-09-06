import type http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { Accounts, loadAccount, type AccountFile } from '../src/main/account-v2'
import { createAdmittedDeviceStore } from '../src/main/admitted-devices'
import { handleIdentityRoutes } from '../src/main/mobile-identity-routes'
import { readHelloReply } from '../src/shared/hello-proof'

/**
 * HELLO v2, END TO END, WITH NOTHING STUBBED.
 *
 * A REAL registry on a port holding a REAL device's public key; the Mac's own
 * `/api/hello` route answering with the private half; the companion's own
 * reading of that answer; and the registry's verdict on the claim that comes
 * out. Three processes' worth of code in one test, because the whole value of
 * this protocol is that the three halves agree about the bytes — and the way
 * that breaks is one of them being changed alone.
 *
 * The path it walks is the attack and its ending: hello, verify, burn, and the
 * same answer refused the second time.
 */

const PASSWORD = 'correct horse battery staple'
const USERNAME = 'drej'
const ZONE = 'd.cookrew.dev'

let dir = ''
let home = ''
let origin = ''
let server: Server
let account: AccountFile
let macOrigin = ''

/** The Mac's own /api/hello, answered by the real route. */
const helloAt = async (
  host: string,
  query: string,
  published: readonly string[]
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const written = { status: 0, body: '' }
  const response = {
    writeHead: (status: number) => {
      written.status = status
      return response
    },
    setHeader: () => undefined,
    end: (chunk?: string) => void (written.body += chunk ?? ''),
    getHeader: () => undefined
  } as unknown as http.ServerResponse
  const request = {
    method: 'GET',
    headers: { host, origin: 'https://cookrew.dev' },
    socket: { encrypted: true, remoteAddress: '192.168.2.9' }
  } as unknown as http.IncomingMessage
  await handleIdentityRoutes(request, response, new URL(`https://${host}/api/hello${query}`), {
    account: () => account,
    registryOrigin: () => 'https://cookrew.dev',
    admitted: createAdmittedDeviceStore({ base: home }),
    selfOrigins: () => [...published]
  })
  return { status: written.status, body: written.body === '' ? {} : JSON.parse(written.body) }
}

const verifyAt = async (claim: unknown): Promise<{ ok?: boolean; reason?: string }> => {
  const response = await fetch(`${origin}/v2/verify-hello`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${account.session?.token ?? ''}`
    },
    body: JSON.stringify(claim)
  })
  return (await response.json()) as { ok?: boolean; reason?: string }
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'hello2-e2e-registry-'))
  home = mkdtempSync(path.join(tmpdir(), 'hello2-e2e-home-'))
  server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2: createV2(dir, { limits: { accountsPerMinute: 100, sessionsPerMinute: 100, helloPerMinute: 100 } })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const app = new Accounts({ base: home, origin, deviceName: 'MacBook Pro' })
  const claimed = await app.claim({ username: USERNAME, password: PASSWORD })
  expect(claimed.ok).toBe(true)
  const stored = loadAccount(home)
  if (stored === null) throw new Error('the account did not land on disk')
  account = stored
  macOrigin = `https://192-168-2-40.${account.deviceId}.${ZONE}:8643`
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('hello, verify, burn, replay', () => {
  const nonce = (): string => randomBytes(16).toString('base64url')

  it('walks the whole path and refuses the second presentation of the same answer', async () => {
    const asked = nonce()
    const host = new URL(macOrigin).host
    const hello = await helloAt(
      host,
      `?nonce=${asked}&origin=${encodeURIComponent(macOrigin)}`,
      [macOrigin]
    )
    expect(hello.status).toBe(200)
    expect(hello.body.origin).toBe(macOrigin)

    // The companion's own reading: version 2, right device, right nonce, and
    // the origin it dialled. Nothing here knows the private key.
    const read = readHelloReply(hello.body, {
      origin: macOrigin,
      deviceId: account.deviceId,
      nonce: asked
    })
    expect(read.ok).toBe(true)
    if (!read.ok) return

    const claim = { deviceId: account.deviceId, nonce: asked, ...read.proof }
    expect(await verifyAt(claim)).toEqual({ ok: true })
    // BURNED. The identical claim — still fresh, still correctly signed — is
    // spent, so anything that recorded it off the wire cannot spend it again.
    expect(await verifyAt(claim)).toEqual({ ok: false, reason: 'replayed' })
  })

  it('refuses at the Mac when the caller dialled a name the Mac never published', async () => {
    // What a rebound name looks like from inside the desktop: a request for a
    // Host it does not answer for. No signature is made at all.
    const hello = await helloAt(
      'evil.example',
      `?nonce=${nonce()}&origin=${encodeURIComponent('https://evil.example')}`,
      [macOrigin]
    )
    expect(hello.status).toBe(421)
    expect(hello.body.sig).toBeUndefined()
  })

  it('refuses at the client when the answer was signed at another origin', async () => {
    // The relay: the box on the LAN forwards the challenge to the real Mac and
    // returns the real Mac's answer as its own.
    const asked = nonce()
    const relayed = await helloAt(
      new URL(macOrigin).host,
      `?nonce=${asked}&origin=${encodeURIComponent(macOrigin)}`,
      [macOrigin]
    )
    const attacker = `https://10-0-0-9.${account.deviceId}.${ZONE}:8643`
    const read = readHelloReply(relayed.body, {
      origin: attacker,
      deviceId: account.deviceId,
      nonce: asked
    })
    expect(read).toEqual({ ok: false, reason: 'wrong_origin' })
    // And had the client not looked, the registry WOULD have said yes — which
    // is why the check has to be at the end that made the connection.
    expect(
      await verifyAt({
        deviceId: account.deviceId,
        nonce: asked,
        origin: relayed.body.origin,
        issuedAtMs: relayed.body.issuedAtMs,
        sig: relayed.body.sig
      })
    ).toEqual({ ok: true })
  })

  it('refuses a claim whose origin is not this desktop, with a name for it', async () => {
    const asked = nonce()
    const hello = await helloAt(
      new URL(macOrigin).host,
      `?nonce=${asked}&origin=${encodeURIComponent(macOrigin)}`,
      [macOrigin]
    )
    expect(
      await verifyAt({
        deviceId: account.deviceId,
        nonce: asked,
        origin: 'https://evil.example',
        issuedAtMs: hello.body.issuedAtMs,
        sig: hello.body.sig
      })
    ).toEqual({ ok: false, reason: 'wrong_origin' })
  })

  it('still answers version 1 to a phone on an older bundle, and verifies it', async () => {
    const asked = nonce()
    const hello = await helloAt(new URL(macOrigin).host, `?nonce=${asked}`, [macOrigin])
    expect(hello.status).toBe(200)
    expect(hello.body.v).toBeUndefined()
    expect(await verifyAt({ deviceId: account.deviceId, nonce: asked, sig: hello.body.sig })).toEqual({
      ok: true
    })
    // The current client refuses it even so: without a signed origin there is
    // no way to tell an honest answer from a relayed one.
    expect(
      readHelloReply(hello.body, { origin: macOrigin, deviceId: account.deviceId, nonce: asked })
    ).toEqual({ ok: false, reason: 'no_version' })
  })
})
