import type http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COMPANION_TOKEN_BYTES,
  createAdmittedDeviceStore,
  hashToken,
  readAdmittedDevices
} from '../src/main/admitted-devices'
import { pairingAuthorized, presentedToken } from '../src/main/mobile-http'
import { tempBase } from './support/idv2'

const GLOBAL = 'the-one-global-pairing-token'
const url = (query = ''): URL => new URL(`https://mac.local:8643/api/state${query}`)
const bearer = (token: string): Pick<http.IncomingMessage, 'headers'> =>
  ({ headers: { authorization: `Bearer ${token}` } }) as http.IncomingMessage

describe('each admitted phone gets its own credential', () => {
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  it('mints 24 bytes and stores ONLY the hash', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    const { token, device } = store.admit({ deviceId: 'p1', name: 'iPhone' })
    expect(Buffer.from(token, 'base64url')).toHaveLength(COMPANION_TOKEN_BYTES)
    expect(device.tokenHash).toBe(hashToken(token))
    // The file is 0600, but a stored bearer token is still a stored bearer
    // token — the plaintext must not be in it.
    const onDisk = JSON.stringify(readAdmittedDevices(temp.base))
    expect(onDisk).not.toContain(token)
    expect(onDisk).toContain(hashToken(token))
  })

  it('gives two phones two different tokens, and neither opens for the other', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    const a = store.admit({ deviceId: 'p1' })
    const b = store.admit({ deviceId: 'p2' })
    expect(a.token).not.toBe(b.token)
    expect(store.accepts(a.token)).toBe(true)
    expect(store.accepts(b.token)).toBe(true)
  })

  it('mints a FRESH token every admission', () => {
    // An admission is somebody standing at the Mac with a valid canvas token,
    // which is exactly the moment to replace whatever the phone was carrying.
    const store = createAdmittedDeviceStore({ base: temp.base })
    const first = store.admit({ deviceId: 'p1' }).token
    const second = store.admit({ deviceId: 'p1' }).token
    expect(second).not.toBe(first)
    expect(store.accepts(first)).toBe(false)
    expect(store.accepts(second)).toBe(true)
  })

  it('refuses a token nobody was ever given', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.admit({ deviceId: 'p1' })
    expect(store.accepts('not-a-token')).toBe(false)
    expect(store.accepts('')).toBe(false)
    expect(store.accepts(GLOBAL)).toBe(false)
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
    const { token } = store.admit({ deviceId: 'p1' })
    expect(pairingAuthorized(bearer(token), url(), GLOBAL, store.accepts)).toBe(true)
  })

  it('takes it as a query token too, which is how the path switch carries it', () => {
    // path/switch.ts hands the credential to the new origin in the URL, the
    // same way the admission redirect did — so a per-device token has to pass
    // the query door or a live switch would land the phone on a 401.
    const store = createAdmittedDeviceStore({ base: temp.base })
    const { token } = store.admit({ deviceId: 'p1' })
    const query = url(`?token=${encodeURIComponent(token)}`)
    expect(presentedToken({ headers: {} } as http.IncomingMessage, query)).toBe(token)
    expect(pairingAuthorized({ headers: {} } as http.IncomingMessage, query, GLOBAL, store.accepts))
      .toBe(true)
  })

  it('REFUSES A FORGOTTEN PHONE — which is what forget is for', () => {
    // Before per-device tokens, every phone held the same global one, so
    // forgetting a device revoked nothing at all.
    const store = createAdmittedDeviceStore({ base: temp.base })
    const { token } = store.admit({ deviceId: 'p1' })
    expect(pairingAuthorized(bearer(token), url(), GLOBAL, store.accepts)).toBe(true)
    expect(store.forget('p1')).toBe(true)
    expect(store.accepts(token)).toBe(false)
    expect(pairingAuthorized(bearer(token), url(), GLOBAL, store.accepts)).toBe(false)
  })

  it('leaves the OTHER phones alone when one is forgotten', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    const kept = store.admit({ deviceId: 'p1' }).token
    const gone = store.admit({ deviceId: 'p2' }).token
    store.forget('p2')
    expect(pairingAuthorized(bearer(kept), url(), GLOBAL, store.accepts)).toBe(true)
    expect(pairingAuthorized(bearer(gone), url(), GLOBAL, store.accepts)).toBe(false)
  })

  it('refuses everything when no credential is presented at all', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.admit({ deviceId: 'p1' })
    expect(pairingAuthorized({ headers: {} } as http.IncomingMessage, url(), GLOBAL, store.accepts))
      .toBe(false)
  })

  it('still works with no second door wired, for a desktop with no account', () => {
    expect(pairingAuthorized(bearer(GLOBAL), url(), GLOBAL)).toBe(true)
    expect(pairingAuthorized(bearer('nope'), url(), GLOBAL)).toBe(false)
  })
})
