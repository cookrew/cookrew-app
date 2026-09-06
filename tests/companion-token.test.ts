import type http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createAdmittedDeviceStore,
  hashToken,
  readAdmittedDevices,
  writeAdmittedDevices
} from '../src/main/admitted-devices'
import { pairingAuthorized, presentedToken } from '../src/main/mobile-http'
import { tempBase } from './support/idv2'

/**
 * THE SECOND DOOR, AFTER THE CEREMONY THAT CUT IT.
 *
 * The retired v2 admission handed each admitted phone 24 bytes of its own and
 * stored the SHA-256 in the admitted-devices file. Reach v2.1 has ONE
 * credential and mints no more of these — but the ones already on disk must
 * keep opening this Mac, or an upgrade unpairs every phone that paired the old
 * way. So the door stays, and FORGET stays the thing that closes it.
 *
 * The rows are therefore SEEDED here rather than minted: that is exactly how
 * they exist in the world now, written by a version that is gone.
 */

const GLOBAL = 'the-one-global-pairing-token'
const url = (query = ''): URL => new URL(`https://mac.local:8643/api/state${query}`)
const bearer = (token: string): Pick<http.IncomingMessage, 'headers'> =>
  ({ headers: { authorization: `Bearer ${token}` } }) as http.IncomingMessage

/** A phone admitted under the old ceremony, as its row survives on disk. */
const seed = (base: string, deviceId: string, token: string): void =>
  writeAdmittedDevices(
    [
      ...readAdmittedDevices(base),
      { deviceId, admittedAt: 1, lastSeenAt: 1, tokenHash: hashToken(token) }
    ],
    base
  )

describe('a per-device token that is already on disk', () => {
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  it('is stored as a hash and never as the token', () => {
    seed(temp.base, 'p1', 'a-phones-own-token')
    const onDisk = JSON.stringify(readAdmittedDevices(temp.base))
    expect(onDisk).not.toContain('a-phones-own-token')
    expect(onDisk).toContain(hashToken('a-phones-own-token'))
  })

  it('opens for its own phone and for no other', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    seed(temp.base, 'p1', 'token-a')
    seed(temp.base, 'p2', 'token-b')
    expect(store.accepts('token-a')).toBe(true)
    expect(store.accepts('token-b')).toBe(true)
    expect(store.accepts('token-c')).toBe(false)
  })

  it('refuses a token nobody was ever given', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    seed(temp.base, 'p1', 'token-a')
    expect(store.accepts('not-a-token')).toBe(false)
    expect(store.accepts('')).toBe(false)
    expect(store.accepts(GLOBAL)).toBe(false)
  })

  it('IS NOT MINTED BY A SIGHTING — recording a phone hands out no credential', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.record({ deviceId: 'p3', name: 'iPhone' })
    expect(store.list()[0].tokenHash).toBeUndefined()
  })
})

describe('the read gate takes both doors', () => {
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  it('accepts the global pairing token, as it always did', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    expect(pairingAuthorized(bearer(GLOBAL), url(), GLOBAL, store.accepts)).toBe(true)
  })

  it("ACCEPTS AN ADMITTED PHONE'S OWN token", () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    seed(temp.base, 'p1', 'token-a')
    expect(pairingAuthorized(bearer('token-a'), url(), GLOBAL, store.accepts)).toBe(true)
  })

  it('takes it as a query token too, which is how the path switch carries it', () => {
    // path/switch.ts hands the credential to the new origin in the URL, so a
    // per-device token has to pass the query door or a live switch would land
    // the phone on a 401.
    const store = createAdmittedDeviceStore({ base: temp.base })
    seed(temp.base, 'p1', 'token-a')
    const query = url('?token=token-a')
    expect(presentedToken({ headers: {} } as http.IncomingMessage, query)).toBe('token-a')
    expect(pairingAuthorized({ headers: {} } as http.IncomingMessage, query, GLOBAL, store.accepts))
      .toBe(true)
  })

  it('REFUSES A FORGOTTEN PHONE — which is what forget is for', () => {
    // Before per-device tokens, every phone held the same global one, so
    // forgetting a device revoked nothing at all.
    const store = createAdmittedDeviceStore({ base: temp.base })
    seed(temp.base, 'p1', 'token-a')
    expect(pairingAuthorized(bearer('token-a'), url(), GLOBAL, store.accepts)).toBe(true)
    expect(store.forget('p1')).toBe(true)
    expect(store.accepts('token-a')).toBe(false)
    expect(pairingAuthorized(bearer('token-a'), url(), GLOBAL, store.accepts)).toBe(false)
  })

  it('leaves the OTHER phones alone when one is forgotten', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    seed(temp.base, 'p1', 'kept')
    seed(temp.base, 'p2', 'gone')
    store.forget('p2')
    expect(pairingAuthorized(bearer('kept'), url(), GLOBAL, store.accepts)).toBe(true)
    expect(pairingAuthorized(bearer('gone'), url(), GLOBAL, store.accepts)).toBe(false)
  })

  it('refuses everything when no credential is presented at all', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    seed(temp.base, 'p1', 'token-a')
    expect(pairingAuthorized({ headers: {} } as http.IncomingMessage, url(), GLOBAL, store.accepts))
      .toBe(false)
  })

  it('still works with no second door wired, for a desktop with no account', () => {
    expect(pairingAuthorized(bearer(GLOBAL), url(), GLOBAL)).toBe(true)
    expect(pairingAuthorized(bearer('nope'), url(), GLOBAL)).toBe(false)
  })
})
