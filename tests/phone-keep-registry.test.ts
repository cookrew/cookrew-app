import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { forgetGrantRests } from '../registry/src/v2-device-grant'
import { PHONE_KEEP_WINDOW_MS } from '../registry/src/v2-accounts'
import { phoneJoinMessage, phoneMatchCode } from '../registry/src/v2-phone-match'
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../registry/src/v2-session-age'
import { SESSION_TTL_MS } from '../registry/src/v2-tokens'
import { GRANT_PATHS } from '../src/shared/account-pair'
import { grantWorld, PASSWORD, type GrantWorld } from './support/grant-world'

/**
 * THE KEEP-IT CONFIRMATION AND THE SESSION THAT LIVES UNTIL REVOKED
 * (owner 2026-11-17).
 *
 * A phone that joined with a phone's code is PENDING until the Mac that
 * minted the code keeps it: it gets no pass and is told why. Remove, or no
 * answer within a few minutes, revokes it everywhere. A kept phone's session
 * is exempt from the thirty-day and seven-day caps; nothing else's is.
 */

const DAY = 24 * 60 * 60 * 1000
let clock = Date.now()
let world: GrantWorld
let n = 0
beforeAll(async () => {
  world = await grantWorld({ now: () => clock })
})
afterAll(async () => world.close())
beforeEach(() => {
  forgetGrantRests()
  clock = Date.now()
})

interface NativePhone {
  readonly device: { id: string; kind: string; name: string; jwk: Record<string, string> }
  readonly key: KeyObject
}

/** The phone's proof that it holds its key, over the code it spends. */
const proofOf = (phone: NativePhone, code: string): string =>
  sign(null, Buffer.from(phoneJoinMessage(code, phone.device.id), 'utf8'), phone.key).toString('base64url')

const nativePhone = (name = 'iPhone'): NativePhone => {
  const pair = generateKeyPairSync('ed25519')
  const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>
  return { device: { id: randomUUID(), kind: 'phone', name, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } }, key: pair.privateKey }
}

const call = async (method: string, p: string, body?: unknown, token?: string) => {
  const response = await fetch(`${world.origin}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await response.text()
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> & unknown[] }
}

/** An account, its Mac signed in, and a phone joined with a code that Mac minted. */
const joinedPhone = async () => {
  const username = `kept${++n}`
  await world.account(username)
  const mac = await world.browser(username, 'desktop')
  const code = (await call('POST', '/v2/me/join-codes', { current: PASSWORD, purpose: 'phone' }, mac.token)).body.code as string
  const phone = nativePhone()
  const joined = await call('POST', '/v2/join', { code, device: phone.device, proof: proofOf(phone, code) })
  expect(joined.status).toBe(201)
  return { username, mac, phone, token: joined.body.token as string }
}

const keep = (macToken: string, id: string) => call('POST', `/v2/me/phones/${id}/keep`, {}, macToken)
const remove = (macToken: string, id: string) => call('POST', `/v2/me/phones/${id}/remove`, {}, macToken)
const pending = (macToken: string) => call('GET', '/v2/me/phones/pending', undefined, macToken)

describe('a phone that joined waits for the Mac that showed the code', () => {
  it('gets no pass until kept, and is told why', async () => {
    const { token } = await joinedPhone()
    const refused = await call('POST', GRANT_PATHS.phone, {}, token)
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ error: 'not_confirmed' })
    expect(String(refused.body.message)).toMatch(/Keep/)
  })

  it('opens nothing else meanwhile: not the account, not its machines, not the relay', async () => {
    const { token } = await joinedPhone()
    expect((await call('GET', '/v2/me', undefined, token)).status).toBe(401)
    expect((await call('GET', '/v2/me/desktops', undefined, token)).status).toBe(401)
    expect((await call('GET', `/api/m/${randomUUID()}/api/auth/status`, undefined, token)).status).toBe(401)
  })

  it('the minting Mac sees it, by name, with when the question ends', async () => {
    const { mac, phone } = await joinedPhone()
    const listed = await pending(mac.token)
    expect(listed.status).toBe(200)
    expect(listed.body).toEqual([{ deviceId: phone.device.id, name: 'iPhone', match: phoneMatchCode(phone.device.jwk), at: clock, until: clock + PHONE_KEEP_WINDOW_MS }])
  })

  it('Keep makes it a trusted phone: its pass comes with no proof, the account opens, and Keep is not asked twice', async () => {
    const { mac, phone, token } = await joinedPhone()
    expect((await keep(mac.token, phone.device.id)).status).toBe(200)
    expect((await call('POST', GRANT_PATHS.phone, {}, token)).status).toBe(201)
    expect((await call('GET', '/v2/me/desktops', undefined, token)).status).toBe(200)
    expect((await pending(mac.token)).body).toEqual([])
    expect((await keep(mac.token, phone.device.id)).status).toBe(404)
  })

  it('Remove takes only a phone that is waiting: never a kept one, never the Mac itself', async () => {
    const { mac, phone } = await joinedPhone()
    await keep(mac.token, phone.device.id)
    expect((await remove(mac.token, phone.device.id)).status).toBe(404)
    expect((await remove(mac.token, mac.device.id)).status).toBe(404)
  })

  it('the window is exact: kept a moment before it ends, gone the moment it does', async () => {
    const first = await joinedPhone()
    clock += PHONE_KEEP_WINDOW_MS - 1
    expect((await keep(first.mac.token, first.phone.device.id)).status).toBe(200)
    const second = await joinedPhone()
    clock += PHONE_KEEP_WINDOW_MS
    expect((await keep(second.mac.token, second.phone.device.id)).status).toBe(404)
  })

  it('a join of its own (a plain code) settles the question: no longer waiting, not trusted, not swept away', async () => {
    const { username, mac, phone } = await joinedPhone()
    const code = (await call('POST', '/v2/me/join-codes', { current: PASSWORD }, mac.token)).body.code as string
    const plain = await call('POST', '/v2/join', { code, device: phone.device })
    expect(plain.status).toBe(201)
    expect((await pending(mac.token)).body).toEqual([])
    clock += PHONE_KEEP_WINDOW_MS + 1
    expect((await call('GET', '/v2/me', undefined, plain.body.token as string)).status).toBe(200)
    expect(world.v2.accounts.revokedFor(username)).not.toContain(phone.device.id)
    expect((await call('POST', GRANT_PATHS.phone, {}, plain.body.token as string)).body).toMatchObject({ error: 'not_phone' })
  })

  it('a phone left waiting when its Mac was revoked does not stall every request: its sittings end', async () => {
    const username = `lonely${++n}`
    await world.account(username)
    const mac = await world.browser(username, 'desktop')
    const code = (await call('POST', '/v2/me/join-codes', { current: PASSWORD, purpose: 'phone' }, mac.token)).body.code as string
    const phone = nativePhone()
    const joined = await call('POST', '/v2/join', { code, device: phone.device, proof: proofOf(phone, code) })
    // Every other device leaves: the waiting phone is the account's last.
    for (const d of world.v2.accounts.get(username)?.devices ?? []) if (d.id !== phone.device.id) world.v2.accounts.revokeDevice(username, d.id)
    clock += PHONE_KEEP_WINDOW_MS + 1
    expect((await call('POST', GRANT_PATHS.phone, {}, joined.body.token as string)).status).toBe(401)
    expect(world.v2.accounts.get(username)?.devices.find((d) => d.id === phone.device.id)?.phonePending).toBeUndefined()
  })

  it('only the Mac that minted the code answers: not another Mac, not the phone, not a browser', async () => {
    const { username, mac, phone, token } = await joinedPhone()
    const other = await world.browser(username, 'desktop')
    expect((await keep(other.token, phone.device.id)).status).toBe(404)
    expect((await pending(other.token)).body).toEqual([])
    // The phone itself opens nothing while it waits, let alone its own Keep.
    expect((await keep(token, phone.device.id)).status).toBe(401)
    const browser = await world.browser(username, 'phone')
    expect((await keep(browser.token, phone.device.id)).status).toBe(404)
    // Still pending, and the right Mac can still keep it.
    expect((await keep(mac.token, phone.device.id)).status).toBe(200)
  })

  it('Remove revokes it everywhere: its session ends and the revoked list names it', async () => {
    const { username, mac, phone, token } = await joinedPhone()
    expect((await remove(mac.token, phone.device.id)).status).toBe(200)
    expect((await call('POST', GRANT_PATHS.phone, {}, token)).status).toBe(401)
    expect(world.v2.accounts.revokedFor(username)).toContain(phone.device.id)
  })

  it('no answer within the window revokes it, whoever asks next', async () => {
    const { username, mac, phone, token } = await joinedPhone()
    clock += PHONE_KEEP_WINDOW_MS + 1
    expect((await call('POST', GRANT_PATHS.phone, {}, token)).status).toBe(401)
    expect(world.v2.accounts.revokedFor(username)).toContain(phone.device.id)
    expect((await keep(mac.token, phone.device.id)).status).toBe(404)
  })

  it('the window passing is seen by the Mac too, which then revokes it', async () => {
    const { username, mac, phone } = await joinedPhone()
    clock += PHONE_KEEP_WINDOW_MS + 1
    expect((await pending(mac.token)).body).toEqual([])
    expect(world.v2.accounts.revokedFor(username)).toContain(phone.device.id)
  })

  it('a trusted phone that rejoins with a new code waits to be kept again', async () => {
    const { mac, phone, token } = await joinedPhone()
    await keep(mac.token, phone.device.id)
    const code = (await call('POST', '/v2/me/join-codes', { current: PASSWORD, purpose: 'phone' }, mac.token)).body.code as string
    const again = await call('POST', '/v2/join', { code, device: phone.device, proof: proofOf(phone, code) })
    expect((await call('POST', GRANT_PATHS.phone, {}, again.body.token as string)).body).toMatchObject({ error: 'not_confirmed' })
    expect((await keep(mac.token, phone.device.id)).status).toBe(200)
    expect((await call('POST', GRANT_PATHS.phone, {}, again.body.token as string)).status).toBe(201)
    // The session from the first join is this phone's too, and is kept with it.
    expect((await call('POST', GRANT_PATHS.phone, {}, token)).status).toBe(201)
  })

  it('a password change or Not me revokes a phone still waiting: its code may have been minted with a stolen password', async () => {
    const { username, mac, phone } = await joinedPhone()
    world.v2.accounts.untrustOtherMachines(username, mac.device.id)
    expect((await keep(mac.token, phone.device.id)).status).toBe(404)
    expect((await pending(mac.token)).body).toEqual([])
    expect(world.v2.accounts.revokedFor(username)).toContain(phone.device.id)
  })
})

describe('a phone proves the key it names, and is named by it', () => {
  const mint = async () => {
    const username = `proof${++n}`
    await world.account(username)
    const mac = await world.browser(username, 'desktop')
    return { mac, code: (await call('POST', '/v2/me/join-codes', { current: PASSWORD, purpose: 'phone' }, mac.token)).body.code as string }
  }

  it('a phone’s code joins no phone without a proof by its key, and the code is spent anyway', async () => {
    const { mac, code } = await mint()
    const phone = nativePhone()
    expect((await call('POST', '/v2/join', { code, device: phone.device })).status).toBe(401)
    expect((await call('POST', '/v2/join', { code, device: phone.device, proof: proofOf(phone, code) })).status).toBe(401)
    expect((await pending(mac.token)).body).toEqual([])
  })

  it('a proof by another key, or over another code, is no proof', async () => {
    const { code } = await mint()
    const phone = nativePhone()
    const stranger = nativePhone()
    expect((await call('POST', '/v2/join', { code, device: phone.device, proof: proofOf(stranger, code) })).status).toBe(401)
    const second = await mint()
    expect((await call('POST', '/v2/join', { code: second.code, device: phone.device, proof: proofOf(phone, 'AAAA-AAAA') })).status).toBe(401)
  })

  it('the match number is the key’s, the same six digits the Go phone shows (shared vector)', () => {
    // tests/fixtures/phone-contract/account-vectors.json, its first key; phone/core/pair pins the same.
    expect(phoneMatchCode({ kty: 'OKP', crv: 'Ed25519', x: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg' })).toBe('532815')
    expect(phoneJoinMessage('K7QM-2XPD', 'EAD074E4-96B9-8ED9-9E02-2CA7BBE51D5A')).toBe('cookrew-join/1 K7QM-2XPD ead074e4-96b9-8ed9-9e02-2ca7bbe51d5a')
  })
})

describe('a kept phone’s session lives until revoked; every other session keeps both caps', () => {
  const renew = async (username: string, phone: NativePhone) => {
    const nonce = (await call('GET', '/v2/sessions/renew-nonce')).body.nonce as string
    const sig = sign(null, Buffer.from(`cookrew-renew/1 ${username} ${phone.device.id} ${nonce}`, 'utf8'), phone.key).toString('base64url')
    return call('POST', '/v2/sessions/renew', { device: phone.device.id, nonce, sig })
  }

  it('past thirty days and past a week unused, a kept phone still asks and renews, and its renewal gives a full month', async () => {
    const { username, mac, phone, token } = await joinedPhone()
    await keep(mac.token, phone.device.id)
    clock += SESSION_IDLE_MS + DAY
    expect((await call('POST', GRANT_PATHS.phone, {}, token)).status).toBe(201)
    clock += SESSION_ABSOLUTE_MS
    const renewed = await renew(username, phone)
    expect(renewed.status).toBe(201)
    expect(renewed.body.exp as number).toBeGreaterThanOrEqual(clock + SESSION_TTL_MS - 1000)
    expect((await call('POST', GRANT_PATHS.phone, {}, renewed.body.token as string)).status).toBe(201)
  })

  it('a desktop and a plain phone still end at seven idle days, while a kept phone of the same account lives on', async () => {
    const { username, mac, phone, token } = await joinedPhone()
    await keep(mac.token, phone.device.id)
    const desk = await world.browser(username, 'desktop')
    const plain = await world.browser(username, 'phone')
    clock += SESSION_IDLE_MS + DAY
    for (const t of [desk.token, plain.token]) expect((await call('GET', '/v2/me', undefined, t)).status).toBe(401)
    expect((await call('GET', '/v2/me', undefined, token)).status).toBe(200)
  })

  it('a phone still waiting renews nothing, as its session opens nothing (security review 2026-11-17)', async () => {
    const { username, phone } = await joinedPhone()
    expect((await renew(username, phone)).status).toBe(401)
  })

  it('a desktop and a plain phone still end at thirty days, however busy', async () => {
    const username = `capped${++n}`
    await world.account(username)
    const desk = await world.browser(username, 'desktop')
    const plain = await world.browser(username, 'phone')
    for (let day = 0; day < 31; day += 5) {
      clock += 5 * DAY
      await call('GET', '/v2/me', undefined, desk.token)
      await call('GET', '/v2/me', undefined, plain.token)
    }
    for (const t of [desk.token, plain.token]) expect((await call('GET', '/v2/me', undefined, t)).status).toBe(401)
  })

  it('once a password change drops the mark, the phone’s session is capped again', async () => {
    const { username, mac, phone, token } = await joinedPhone()
    await keep(mac.token, phone.device.id)
    world.v2.accounts.untrustOtherMachines(username, mac.device.id)
    clock += SESSION_IDLE_MS + DAY
    expect((await call('GET', '/v2/me', undefined, token)).status).toBe(401)
  })
})
