import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { forgetGrantRests } from '../registry/src/v2-device-grant'
import { JoinCodes } from '../registry/src/v2-join-codes'
import { GRANT_TTL_MS } from '../registry/src/v2-tokens'
import { v2GrantClaimsFor, v2MachineGrantClaimsFor, v2PhoneGrantClaimsFor, v2WatchGrantClaimsFor } from '../src/main/v2-call-token'
import { jwkThumbprint } from '../src/shared/jwk-thumbprint'
import { GRANT_PATHS } from '../src/shared/account-pair'
import { grantWorld, httpWithBearer, PASSWORD, type GrantWorld } from './support/grant-world'

/**
 * THE PHONE PASS, AT cookrew.dev (owner 2026-11-16).
 *
 * The native phone app joins by a QR a signed-in machine shows under step-up,
 * and is then trusted until it is revoked: it asks for a pass whenever it
 * likes, with no proof, and enters every machine of the account. What earns
 * that is the code's PURPOSE, never the kind a device says it is — "phone" is
 * a kind any password sign-in may name.
 */

let world: GrantWorld
let n = 0
beforeAll(async () => {
  world = await grantWorld()
})
afterAll(async () => world.close())
beforeEach(() => forgetGrantRests())

/** A phone as the native app makes it: Ed25519, its own random id. */
const nativePhone = (name = 'iPhone') => {
  const pair = generateKeyPairSync('ed25519')
  const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>
  return { id: randomUUID(), kind: 'phone', name, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } }
}

const post = async (p: string, body: unknown, token?: string) => {
  const response = await fetch(`${world.origin}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> }
}

/** An account, with the Mac it was made on signed in. */
const owner = async () => {
  const username = `phoned${++n}`
  await world.account(username)
  const desk = await world.browser(username, 'desktop')
  return { username, desk }
}

const codeFor = async (token: string, purpose?: string): Promise<string> => {
  const out = await post('/v2/me/join-codes', { current: PASSWORD, ...(purpose ? { purpose } : {}) }, token)
  expect(out.status).toBe(201)
  return out.body.code as string
}

/** Join with a code: the phone's session token. */
const join = async (code: string, device: ReturnType<typeof nativePhone>) => post('/v2/join', { code, device })

describe('the join-code store keeps a phone’s purpose', () => {
  it('mints and spends a phone code as one', () => {
    const codes = new JoinCodes()
    const minted = codes.mint('drej', 'phone')
    expect(minted.purpose).toBe('phone')
    expect(codes.spend(minted.code)?.purpose).toBe('phone')
  })
})

describe('a phone’s code makes a trusted phone (owner 2026-11-16: QR join, trusted until revoked)', () => {
  it('only a machine mints one (owner 2026-11-16: the Mac shows the QR), not a phone or a browser', async () => {
    const { username } = await owner()
    const phone = await world.browser(username, 'phone')
    const out = await post('/v2/me/join-codes', { current: PASSWORD, purpose: 'phone' }, phone.token)
    expect(out.status).toBe(403)
    expect(out.body).toMatchObject({ error: 'not_machine' })
  })

  it('needs the step-up like any code: a session alone mints nothing', async () => {
    const { desk } = await owner()
    const bare = await post('/v2/me/join-codes', { purpose: 'phone' }, desk.token)
    expect(bare.status).not.toBe(201)
  })

  it('a phone joined with a phone’s code gets its pass with no proof, for its own key, in a scope no older machine reads', async () => {
    const { username, desk } = await owner()
    const phone = nativePhone()
    const joined = await join(await codeFor(desk.token, 'phone'), phone)
    expect(joined.status).toBe(201)
    const before = Date.now()
    const out = await post(GRANT_PATHS.phone, {}, joined.body.token as string)
    expect(out.status).toBe(201)
    expect(out.body.deviceId).toBe(phone.id)
    const grant = out.body.grant as string
    const claims = v2PhoneGrantClaimsFor(grant, Date.now())
    expect(claims).toMatchObject({ username, dev: phone.id, jkt: jwkThumbprint(phone.jwk), phone: true })
    // The moment the phone was trusted rides on the pass: a machine that forgot this phone keeps it out until it joins again.
    expect(typeof claims?.since).toBe('number')
    expect((out.body.exp as number) - before).toBeLessThanOrEqual(GRANT_TTL_MS + 1000)
    // Every machine older than the phone pass reads it as no pass at all.
    expect(v2GrantClaimsFor(grant, Date.now())).toBeNull()
    expect(v2WatchGrantClaimsFor(grant, Date.now())).toBeNull()
    expect(v2MachineGrantClaimsFor(grant, Date.now())).toBeNull()
    // And asked again, no proof again: the phone is trusted until it is revoked.
    expect((await post(GRANT_PATHS.phone, {}, joined.body.token as string)).status).toBe(201)
  })

  it('a phone signed in with the password, or joined with any other code, is not a trusted phone', async () => {
    const { username, desk } = await owner()
    const signedIn = await world.browser(username, 'phone')
    const refused = await signedIn.registry.post(GRANT_PATHS.phone, {})
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ error: 'not_phone' })
    const plain = await join(await codeFor(desk.token), nativePhone())
    expect(plain.status).toBe(201)
    expect((await post(GRANT_PATHS.phone, {}, plain.body.token as string)).status).toBe(403)
  })

  it('a phone’s code joins a phone and nothing else', async () => {
    const { desk } = await owner()
    for (const kind of ['desktop', 'browser', 'watch']) {
      const out = await join(await codeFor(desk.token, 'phone'), { ...nativePhone(), kind })
      expect(out.status).toBe(400)
    }
  })

  it('a known desktop cannot be turned into a trusted phone by a phone’s code', async () => {
    const { username, desk } = await owner()
    const other = await world.browser(username, 'desktop', { verified: false })
    const as = world.v2.accounts.get(username)?.devices.find((d) => d.id === other.device.id)
    expect(as).toBeDefined()
    const out = await post('/v2/join', { code: await codeFor(desk.token, 'phone'), device: { id: other.device.id, kind: 'phone', name: 'iPhone', jwk: as?.jwk } })
    expect(out.status).toBe(400)
  })

  it('a watch, a desktop or a browser is not a phone', async () => {
    const { username, desk } = await owner()
    expect((await desk.registry.post(GRANT_PATHS.phone, {})).body).toMatchObject({ error: 'not_phone' })
    const watch = await world.browser(username, 'watch')
    expect((await watch.registry.post(GRANT_PATHS.phone, {})).status).toBe(403)
  })

  it('needs a session: a stranger gets nothing', async () => {
    expect((await post(GRANT_PATHS.phone, {})).status).toBe(401)
  })

  it('an account locked by Not me gives a phone nothing', async () => {
    const { username, desk } = await owner()
    const joined = await join(await codeFor(desk.token, 'phone'), nativePhone())
    world.v2.factors.store.setMustChangePassword(username, true)
    expect((await post(GRANT_PATHS.phone, {}, joined.body.token as string)).status).toBe(403)
    world.v2.factors.store.setMustChangePassword(username, false)
  })

  it('a revoked phone asks for nothing: its session is gone', async () => {
    const { username, desk } = await owner()
    const phone = nativePhone()
    const joined = await join(await codeFor(desk.token, 'phone'), phone)
    world.v2.accounts.revokeDevice(username, phone.id)
    expect((await post(GRANT_PATHS.phone, {}, joined.body.token as string)).status).toBe(401)
  })

  it('joining again with a new phone code moves the moment it was trusted forward', async () => {
    const { desk } = await owner()
    const phone = nativePhone()
    const first = await join(await codeFor(desk.token, 'phone'), phone)
    const one = v2PhoneGrantClaimsFor((await post(GRANT_PATHS.phone, {}, first.body.token as string)).body.grant as string, Date.now())
    await new Promise((resolve) => setTimeout(resolve, 5))
    const again = await join(await codeFor(desk.token, 'phone'), phone)
    expect(again.status).toBe(201)
    const two = v2PhoneGrantClaimsFor((await post(GRANT_PATHS.phone, {}, again.body.token as string)).body.grant as string, Date.now())
    expect(two?.since).toBeGreaterThan(one?.since as number)
  })
})

describe('a phone’s trust ends with the password it was joined under (as a machine’s does)', () => {
  it('a password change drops it, and only a new phone code brings it back', async () => {
    const { username, desk } = await owner()
    const phone = nativePhone()
    expect((await join(await codeFor(desk.token, 'phone'), phone)).status).toBe(201)
    expect(typeof world.v2.accounts.get(username)?.devices.find((d) => d.id === phone.id)?.phonePassAt).toBe('number')
    expect((await desk.registry.post('/v2/me/password', { current: PASSWORD, next: 'a brand new long password' })).status).toBe(204)
    expect(world.v2.accounts.get(username)?.devices.find((d) => d.id === phone.id)?.phonePassAt).toBeUndefined()
  })

  it('“Not me” takes it from every phone', async () => {
    const { username, desk } = await owner()
    const phone = nativePhone()
    await join(await codeFor(desk.token, 'phone'), phone)
    expect(typeof world.v2.accounts.get(username)?.devices.find((d) => d.id === phone.id)?.phonePassAt).toBe('number')
    world.v2.accounts.untrustOtherMachines(username, desk.device.id)
    expect(world.v2.accounts.get(username)?.devices.find((d) => d.id === phone.id)?.phonePassAt).toBeUndefined()
  })

  it('a phone that walks back in by a plain code or a sign-in is not trusted again by it', async () => {
    const { username, desk } = await owner()
    const phone = nativePhone()
    await join(await codeFor(desk.token, 'phone'), phone)
    world.v2.accounts.untrustOtherMachines(username, desk.device.id)
    const plain = await join(await codeFor(desk.token), phone)
    expect(plain.status).toBe(201)
    expect((await post(GRANT_PATHS.phone, {}, plain.body.token as string)).status).toBe(403)
    // Signed in again with the password, as the same device: still asked to scan a phone's code.
    // Signed in again as the same device, the way every sign-in attaches one (no phone's code): still not trusted.
    expect(world.v2.accounts.attachDevice(username, phone).ok).toBe(true)
    const sitting = world.v2.accounts.startSession(username, phone.id, { verifiedBy: 'password' })
    const token = world.v2.tokens.mintSession(username, phone.id, sitting?.jti).token
    expect((await post(GRANT_PATHS.phone, {}, token)).status).toBe(403)
    expect(world.v2.accounts.get(username)?.devices.find((d) => d.id === phone.id)?.phonePassAt).toBeUndefined()
  })
})

describe('a trusted phone joining again', () => {
  it('by a plain code, as a phone, keeps its trust', async () => {
    const { username, desk } = await owner()
    const phone = nativePhone()
    await join(await codeFor(desk.token, 'phone'), phone)
    const at = world.v2.accounts.get(username)?.devices.find((d) => d.id === phone.id)?.phonePassAt
    expect(typeof at).toBe('number')
    const again = await join(await codeFor(desk.token), phone)
    expect(again.status).toBe(201)
    expect(world.v2.accounts.get(username)?.devices.find((d) => d.id === phone.id)?.phonePassAt).toBe(at)
    expect((await post(GRANT_PATHS.phone, {}, again.body.token as string)).status).toBe(201)
  })

  it('as something other than a phone, loses it', async () => {
    const { username, desk } = await owner()
    const phone = nativePhone()
    await join(await codeFor(desk.token, 'phone'), phone)
    expect(typeof world.v2.accounts.get(username)?.devices.find((d) => d.id === phone.id)?.phonePassAt).toBe('number')
    // Re-attached as a browser by a plain code, it is no longer a trusted phone.
    expect((await join(await codeFor(desk.token), { ...phone, kind: 'browser' })).status).toBe(201)
    expect(world.v2.accounts.get(username)?.devices.find((d) => d.id === phone.id)?.phonePassAt).toBeUndefined()
  })
})

describe('what a code may be minted for', () => {
  it('a purpose it does not know mints a plain code, which makes no trusted phone', async () => {
    const { desk } = await owner()
    const joined = await join(await codeFor(desk.token, 'machine'), nativePhone())
    expect(joined.status).toBe(201)
    expect((await post(GRANT_PATHS.phone, {}, joined.body.token as string)).status).toBe(403)
  })

  it('a phone asking in a stream is told to rest', async () => {
    const { desk } = await owner()
    const joined = await join(await codeFor(desk.token, 'phone'), nativePhone())
    const statuses: number[] = []
    for (let i = 0; i < 40; i++) statuses.push((await post(GRANT_PATHS.phone, {}, joined.body.token as string)).status)
    expect(statuses).toContain(429)
  })
})

describe('a phone pass is a grant in its own scope', () => {
  it('is not a session either', async () => {
    const { desk } = await owner()
    const joined = await join(await codeFor(desk.token, 'phone'), nativePhone())
    const grant = (await post(GRANT_PATHS.phone, {}, joined.body.token as string)).body.grant as string
    expect((await httpWithBearer(world.origin, grant).get('/v2/me')).status).toBe(401)
  })
})
