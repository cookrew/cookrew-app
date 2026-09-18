// POST /api/admit — the ceremony that turns the root pairing token into a
// phone's own credential (v3, V3-21), walked over the wire shape the
// companion (V3-14) will send: a device key proof in the same three-refusal
// shape as the version 2 hello, in the other direction.

import type http from 'node:http'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAdmittedDeviceStore, readAdmittedDevices } from '../src/main/admitted-devices'
import { deviceIdFor, mintDeviceKey, signWithDevice } from '../src/main/account-v2'
import { companionAccepted } from '../src/main/companion-gate'
import { admitMessage, readAdmission } from '../src/main/device-hello'
import { handleIdentityRoutes, type MobileIdentityDeps } from '../src/main/mobile-identity-routes'
import { fakeAccount, tempBase } from './support/idv2'

const NOW = 1_800_000_000_000
const REGISTRY = 'https://cookrew.dev'
const MAC_ORIGIN = 'https://192-168-1-24.abcd.d.cookrew.dev:8643'
const ROOT = 'the-root-pairing-token-abcdefgh'

/** A phone: its own Ed25519 key, its id the key's thumbprint. */
const phone = (name = 'iPhone') => {
  const keys = mintDeviceKey()
  const deviceId = deviceIdFor(keys.publicKeyJwk)
  // signWithDevice only needs the private JWK, so a stand-in account file is
  // the cheapest way to sign as the phone.
  const signer = fakeAccount({ deviceId, privateKeyJwk: keys.privateKeyJwk, publicKeyJwk: keys.publicKeyJwk })
  const proof = (origin = MAC_ORIGIN, issuedAtMs = NOW, over: Record<string, unknown> = {}) => {
    const nonce = randomBytes(32).toString('base64url')
    return {
      deviceId,
      name,
      jwk: keys.publicKeyJwk,
      nonce,
      issuedAtMs,
      sig: signWithDevice(signer, admitMessage(deviceId, origin, issuedAtMs, nonce)),
      ...over,
    }
  }
  return { deviceId, keys, proof }
}

const recorder = () => {
  const written: { status: number; headers: Record<string, string>; body: string } = { status: 0, headers: {}, body: '' }
  const response = {
    writeHead: (status: number, headers?: Record<string, string>) => {
      written.status = status
      written.headers = { ...written.headers, ...(headers ?? {}) }
      return response
    },
    setHeader: (name: string, value: string) => void (written.headers[name] = value),
    end: (chunk?: string) => void (written.body += chunk ?? ''),
    getHeader: (name: string) => written.headers[name],
  }
  return { written, response: response as unknown as http.ServerResponse }
}

/** A POST over TLS from the LAN, with a JSON body and a bearer. */
const post = (body: unknown, bearer: string | null, over: Record<string, unknown> = {}): http.IncomingMessage => {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  Object.assign(stream, {
    method: 'POST',
    headers: {
      host: '192-168-1-24.abcd.d.cookrew.dev:8643',
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    socket: { encrypted: true, remoteAddress: '192.168.1.9', localAddress: '192.168.1.24' },
    ...over,
  })
  return stream
}

describe('readAdmission, the pure half', () => {
  it('accepts a proof signed by the key the id names, for the address it arrived at', () => {
    const p = phone()
    expect(readAdmission({ body: p.proof(), arrived: MAC_ORIGIN, bridged: null, now: NOW })).toEqual({
      ok: true,
      deviceId: p.deviceId,
      name: 'iPhone',
    })
  })

  it('refuses an id that is not the thumbprint of the key sent', () => {
    const p = phone()
    const other = phone()
    const out = readAdmission({ body: p.proof(MAC_ORIGIN, NOW, { deviceId: other.deviceId }), arrived: MAC_ORIGIN, bridged: null, now: NOW })
    expect(out).toMatchObject({ ok: false, status: 401 })
  })

  it('refuses a proof made for another Mac, and one that is too old', () => {
    const p = phone()
    expect(
      readAdmission({ body: p.proof('https://other-mac.local:8643'), arrived: MAC_ORIGIN, bridged: null, now: NOW }),
    ).toMatchObject({ ok: false, status: 401 })
    expect(
      readAdmission({ body: p.proof(MAC_ORIGIN, NOW - 200_000), arrived: MAC_ORIGIN, bridged: null, now: NOW }),
    ).toMatchObject({ ok: false, status: 401 })
  })

  it('is 421 when the request did not arrive at a name this Mac published', () => {
    const p = phone()
    expect(readAdmission({ body: p.proof(), arrived: null, bridged: null, now: NOW })).toMatchObject({ ok: false, status: 421 })
  })

  it('refuses a malformed body before it spends a verification', () => {
    const p = phone()
    for (const over of [{ deviceId: 'nope' }, { jwk: { kty: 'RSA' } }, { nonce: 'short' }, { issuedAtMs: 'now' }, { sig: '' }]) {
      expect(readAdmission({ body: p.proof(MAC_ORIGIN, NOW, over), arrived: MAC_ORIGIN, bridged: null, now: NOW })).toMatchObject({
        ok: false,
        status: 400,
      })
    }
  })

  it('DOWN THE BRIDGE the stamp is the identity: no proof is asked, a different id is refused', () => {
    const stamped = { deviceId: 'cccccccc-1111-8222-8333-444444444444', name: 'iPhone' }
    expect(readAdmission({ body: {}, arrived: null, bridged: stamped, now: NOW })).toEqual({ ok: true, ...stamped })
    expect(readAdmission({ body: { deviceId: 'dddddddd-1111-8222-8333-444444444444' }, arrived: null, bridged: stamped, now: NOW })).toMatchObject({
      ok: false,
      status: 401,
    })
  })
})

describe('POST /api/admit over the wire', () => {
  const account = fakeAccount()
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  const deps = (over: Partial<MobileIdentityDeps> = {}): MobileIdentityDeps => ({
    account: () => account,
    registryOrigin: () => REGISTRY,
    admitted: createAdmittedDeviceStore({ base: temp.base }),
    selfOrigins: () => [MAC_ORIGIN],
    now: () => NOW,
    pairingToken: () => ROOT,
    ...over,
  })

  const admit = async (body: unknown, bearer: string | null, d = deps()) => {
    const { written, response } = recorder()
    const handled = await handleIdentityRoutes(post(body, bearer), response, new URL(`${MAC_ORIGIN}/api/admit`), d)
    return { handled, written, body: written.body ? (JSON.parse(written.body) as Record<string, unknown>) : {} }
  }

  it('mints a per-device token for the root token plus a good proof, and files only the hash', async () => {
    const d = deps()
    const p = phone()
    const { handled, written, body } = await admit(p.proof(), ROOT, d)
    expect(handled).toBe(true)
    expect(written.status).toBe(200)
    expect(body.deviceId).toBe(p.deviceId)
    expect(body.name).toBe('iPhone')
    expect(body.desktopId).toBe(account.deviceId)
    expect(typeof body.token).toBe('string')
    expect((body.token as string).length).toBe(32)
    const rows = readAdmittedDevices(temp.base)
    expect(rows).toHaveLength(1)
    expect(rows[0].deviceId).toBe(p.deviceId)
    expect(JSON.stringify(rows)).not.toContain(body.token as string)
    expect(d.admitted.accepts(body.token as string)).toBe(true)
  })

  it('THE MINTED TOKEN OPENS EVERY ROUTE IN STRICT MODE, AND THE ROOT DOES NOT', async () => {
    const d = deps()
    const { body } = await admit(phone().proof(), ROOT, d)
    const strict = (presented: string) =>
      companionAccepted({ route: 'other', presented, rootToken: ROOT, perDevice: d.admitted.deviceFor, rootEverywhere: false })
    expect(strict(body.token as string)).toBe(true)
    expect(strict(ROOT)).toBe(false)
  })

  it('refuses without a credential, and without spending a verification', async () => {
    const { written } = await admit(phone().proof(), null)
    expect(written.status).toBe(401)
    expect(readAdmittedDevices(temp.base)).toHaveLength(0)
  })

  it('refuses a stranger who has the root token but not the key for the id', async () => {
    const p = phone()
    const other = phone()
    const { written } = await admit(p.proof(MAC_ORIGIN, NOW, { deviceId: other.deviceId }), ROOT)
    expect(written.status).toBe(401)
    expect(readAdmittedDevices(temp.base)).toHaveLength(0)
  })

  it('re-admitting with the per-device token rotates it: one row, the old token dead', async () => {
    const d = deps()
    const p = phone()
    const first = await admit(p.proof(), ROOT, d)
    const second = await admit(p.proof(), first.body.token as string, d)
    expect(second.written.status).toBe(200)
    expect(readAdmittedDevices(temp.base)).toHaveLength(1)
    expect(d.admitted.accepts(second.body.token as string)).toBe(true)
    expect(d.admitted.accepts(first.body.token as string)).toBe(false)
  })

  it('admits a stamped device down the bridge with an empty body', async () => {
    const d = deps()
    const stamped = { deviceId: 'cccccccc-1111-8222-8333-444444444444', name: 'iPhone' }
    const { written, response } = recorder()
    await handleIdentityRoutes(post({}, ROOT), response, new URL(`${MAC_ORIGIN}/api/admit`), d, stamped)
    expect(written.status).toBe(200)
    expect(readAdmittedDevices(temp.base)[0]).toMatchObject({ deviceId: stamped.deviceId, name: 'iPhone' })
  })

  it('answers nothing for a Mac with no account, and is a POST only', async () => {
    const { written } = await admit(phone().proof(), ROOT, deps({ account: () => null }))
    expect(written.status).toBe(404)
    const { written: get, response } = recorder()
    await handleIdentityRoutes(post({}, ROOT, { method: 'GET' }), response, new URL(`${MAC_ORIGIN}/api/admit`), deps())
    expect(get.status).toBe(405)
  })

  it('a revoke at the registry ends the minted token within the prune, the other phone keeps working', async () => {
    const d = deps()
    const a = (await admit(phone('iPhone').proof(), ROOT, d)).body.token as string
    const bDevice = phone('iPad')
    const b = (await admit(bDevice.proof(), ROOT, d)).body.token as string
    const aId = readAdmittedDevices(temp.base).find((r) => r.name === 'iPhone')?.deviceId as string
    d.admitted.prune([aId])
    expect(d.admitted.accepts(a)).toBe(false)
    expect(d.admitted.accepts(b)).toBe(true)
  })
})

/* ── H1: the ghost admission ───────────────────────────────────────────── */

describe('an admitted phone may admit ITSELF and nobody else (H1)', () => {
  const account = fakeAccount()
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  const deps = (over: Partial<MobileIdentityDeps> = {}): MobileIdentityDeps => ({
    account: () => account,
    registryOrigin: () => REGISTRY,
    admitted: createAdmittedDeviceStore({ base: temp.base }),
    selfOrigins: () => [MAC_ORIGIN],
    now: () => NOW,
    pairingToken: () => ROOT,
    ...over,
  })

  const admit = async (body: unknown, bearer: string | null, d: MobileIdentityDeps) => {
    const { written, response } = recorder()
    await handleIdentityRoutes(post(body, bearer), response, new URL(`${MAC_ORIGIN}/api/admit`), d)
    return {
      status: written.status,
      body: written.body ? (JSON.parse(written.body) as Record<string, unknown>) : {},
    }
  }

  /**
   * THE ATTACK, AS THE REVIEW REPRODUCED IT.
   *
   * The credential says WHICH phone is asking; the body says which device the
   * token is for. Nothing bound them, so a phone the owner admitted once could
   * mint a second credential for a key it invented — an id the account and the
   * registry have never seen, which therefore never appears in the revoked
   * list, which therefore survives `prune` for ever. Revoking the phone the
   * owner knows about does not touch the one it made.
   *
   * The fix is a sentence long: the opener is the device, so the body may not
   * name another. Admitting a NEW device stays the root token's job, which is
   * the one credential the owner can rotate.
   */
  it('refuses a device token that asks for a token in another device’s name', async () => {
    const d = deps()
    const real = phone('iPhone')
    const bootstrapped = await admit(real.proof(), ROOT, d)
    expect(bootstrapped.status).toBe(200)
    const held = bootstrapped.body.token as string

    // The ghost: a key this Mac has never seen, proved perfectly — the proof
    // is not what is wrong with it.
    const ghost = phone('Ghost')
    const attack = await admit(ghost.proof(), held, d)

    expect(attack.status).toBe(403)
    expect(readAdmittedDevices(temp.base).map((row) => row.deviceId)).toEqual([real.deviceId])
    expect(d.admitted.accepts(attack.body.token as string)).toBe(false)
  })

  it('leaves the ghost unreachable by the owner’s revoke — the reason it matters', async () => {
    const d = deps()
    const real = phone('iPhone')
    const held = (await admit(real.proof(), ROOT, d)).body.token as string
    const ghost = phone('Ghost')
    const attack = await admit(ghost.proof(), held, d)
    const ghostToken = attack.body.token as string

    // What the owner can do: revoke the phone they know about. The registry
    // publishes THAT id; `prune` forgets the rows it names.
    d.admitted.prune([real.deviceId])
    expect(d.admitted.accepts(held)).toBe(false)

    // The ghost's id was never on the account, so no revoke can ever name it.
    // Before the fix this token still opened the Mac; after it, it was never
    // minted at all.
    expect(typeof ghostToken).not.toBe('string')
    expect(d.admitted.accepts(String(ghostToken))).toBe(false)
    expect(readAdmittedDevices(temp.base)).toHaveLength(0)
  })

  it('still lets a phone re-mint its OWN token, which is how a cleared browser recovers', async () => {
    const d = deps()
    const real = phone('iPhone')
    const first = (await admit(real.proof(), ROOT, d)).body.token as string
    const again = await admit(real.proof(), first, d)
    expect(again.status).toBe(200)
    expect(d.admitted.accepts(again.body.token as string)).toBe(true)
    expect(d.admitted.accepts(first)).toBe(false)
    expect(readAdmittedDevices(temp.base)).toHaveLength(1)
  })

  it('leaves the ROOT token the one way a NEW device is admitted', async () => {
    const d = deps()
    const first = phone('iPhone')
    await admit(first.proof(), ROOT, d)
    const second = phone('iPad')
    const admitted = await admit(second.proof(), ROOT, d)
    expect(admitted.status).toBe(200)
    expect(readAdmittedDevices(temp.base)).toHaveLength(2)
  })
})

/* ── (a) the credential does not travel in the URL ─────────────────────── */

describe('the admission token goes in a header, never in the query', () => {
  const account = fakeAccount()
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  const deps = (): MobileIdentityDeps => ({
    account: () => account,
    registryOrigin: () => REGISTRY,
    admitted: createAdmittedDeviceStore({ base: temp.base }),
    selfOrigins: () => [MAC_ORIGIN],
    now: () => NOW,
    pairingToken: () => ROOT,
  })

  const call = async (body: unknown, bearer: string | null, query: string, d: MobileIdentityDeps) => {
    const { written, response } = recorder()
    await handleIdentityRoutes(
      post(body, bearer),
      response,
      new URL(`${MAC_ORIGIN}/api/admit${query}`),
      d,
    )
    return {
      status: written.status,
      body: written.body ? (JSON.parse(written.body) as Record<string, unknown>) : {},
    }
  }

  /**
   * WHY THIS ROUTE MAY NOT TAKE `?token=`.
   *
   * The query form exists in this codebase for exactly one reason, and the
   * reason is written down at auth-gate.ts · tokenParam: `EventSource` cannot
   * set a header, so the two streams that are EventSources carry the token in
   * the URL and nothing else does. A POST can set a header. So the only thing
   * a query token buys here is the places a URL goes that a header does not —
   * a server log, a `Referer`, a screenshot of an address bar, a shell
   * history — and what it carries is the credential that admits a device to
   * this Mac.
   *
   * REFUSED, NOT IGNORED. By the time this server sees it the token has
   * already been written wherever this request was logged; serving the call
   * anyway would mint a fresh credential off one that must now be treated as
   * exposed, and would leave the client author believing the shape is
   * supported.
   */
  it('refuses the root token in the query, and mints nothing', async () => {
    const d = deps()
    const out = await call(phone('iPhone').proof(), null, `?token=${ROOT}`, d)
    expect(out.status).toBe(400)
    expect(String(out.body.error)).toMatch(/header/i)
    expect(readAdmittedDevices(temp.base)).toHaveLength(0)
  })

  it('refuses a per-device token in the query too — the same leak, a smaller key', async () => {
    const d = deps()
    const real = phone('iPhone')
    const held = (await call(real.proof(), ROOT, '', d)).body.token as string
    const out = await call(real.proof(), null, `?token=${held}`, d)
    expect(out.status).toBe(400)
    // The row it already had is untouched: a refused re-mint must not rotate
    // the token the phone is still using.
    expect(d.admitted.accepts(held)).toBe(true)
  })

  it('refuses even when a good header is there too — the URL has already leaked', async () => {
    const d = deps()
    const out = await call(phone('iPhone').proof(), ROOT, `?token=${ROOT}`, d)
    expect(out.status).toBe(400)
    expect(readAdmittedDevices(temp.base)).toHaveLength(0)
  })

  it('refuses an EMPTY query token as well — the shape is what is wrong', async () => {
    const d = deps()
    expect((await call(phone('iPhone').proof(), ROOT, '?token=', d)).status).toBe(400)
  })

  it('still takes the header, which is the one way in', async () => {
    const d = deps()
    expect((await call(phone('iPhone').proof(), ROOT, '', d)).status).toBe(200)
  })
})
