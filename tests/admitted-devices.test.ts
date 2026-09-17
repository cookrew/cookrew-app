import { chmodSync, statSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  admittedDevicesFile,
  createAdmittedDeviceStore,
  readAdmittedDevices
} from '../src/main/admitted-devices'
import { tempBase } from './support/idv2'

/**
 * PHONES THIS MAC HAS LET IN — the file, on its own.
 *
 * These cases used to live in tests/admission.test.ts, behind the
 * `?open=&key=&device=` ceremony that wrote the rows. The ceremony is gone
 * (reach v2.1: one credential, the pairing token) and the file is not: it is
 * still what the account sheet lists and what FORGET removes, so its
 * behaviour is asserted here rather than deleted with the ceremony.
 */

const PHONE = 'phone-device-1'

describe('the admitted-devices file', () => {
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  it('is written 0600 — it decides who opens this Mac', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.record({ deviceId: PHONE })
    expect(statSync(admittedDevicesFile(temp.base)).mode & 0o777).toBe(0o600)
  })

  it('reads an absent or corrupt file as nobody admitted, never as a crash', () => {
    expect(readAdmittedDevices(temp.base)).toEqual([])
    const store = createAdmittedDeviceStore({ base: temp.base })
    expect(store.has(PHONE)).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('lists the most recently seen phone first', () => {
    let clock = 1000
    const store = createAdmittedDeviceStore({ base: temp.base, now: () => clock })
    store.record({ deviceId: 'a' })
    clock = 2000
    store.record({ deviceId: 'b' })
    expect(store.list().map((d) => d.deviceId)).toEqual(['b', 'a'])
  })
})

describe('forgetting an admitted phone answers the question that was asked', () => {
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  it('is TRUE for a phone that was there, and true again for one that was not', () => {
    // "Did I rewrite a row" and "is this phone forgotten" are different
    // questions, and only the second is the one the sheet is asking. The old
    // answer reported false while succeeding, and the row came back.
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.record({ deviceId: PHONE })
    expect(store.forget(PHONE)).toBe(true)
    expect(store.forget(PHONE)).toBe(true)
    expect(store.has(PHONE)).toBe(false)
  })

  it('is true for a phone this Mac never admitted', () => {
    expect(createAdmittedDeviceStore({ base: temp.base }).forget('never-here')).toBe(true)
  })

  it('is FALSE only when the file would not take the change', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.record({ deviceId: PHONE })
    // Readable but not writable: the row can still be seen, so this is a real
    // failure to remove it rather than a "nothing was there" no-op — the one
    // case where the sheet must keep the phone on screen.
    chmodSync(temp.base, 0o500)
    try {
      expect(store.forget(PHONE)).toBe(false)
      expect(store.has(PHONE)).toBe(true)
    } finally {
      chmodSync(temp.base, 0o700)
    }
  })
})

describe('pruning the phones the registry has revoked', () => {
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  it('forgets every admitted phone the list names, and says which ones', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.record({ deviceId: 'cut', name: 'Old phone' })
    store.record({ deviceId: 'kept' })

    const forgotten = store.prune(['cut'])

    expect(forgotten.map((device) => device.deviceId)).toEqual(['cut'])
    // The row comes back so the caller can name the phone in its notice; a
    // count would leave the owner reading "1 device" with no idea which.
    expect(forgotten[0].name).toBe('Old phone')
    expect(store.has('cut')).toBe(false)
    expect(store.has('kept')).toBe(true)
  })

  it('AN EMPTY LIST FORGETS NOBODY, and does not even open the file to write', () => {
    // A malformed revoked list reads as empty (v2-call-token.ts), so "the
    // registry told us nothing" arrives here as []. Reading that as "forget
    // everyone" would unpair every phone on one bad deploy of the registry.
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.record({ deviceId: 'kept' })
    chmodSync(temp.base, 0o500)
    try {
      expect(store.prune([])).toEqual([])
    } finally {
      chmodSync(temp.base, 0o700)
    }
    expect(store.has('kept')).toBe(true)
  })

  it('passes a session id through inert — it is a filter on OUR ids', () => {
    // /v2/keys lists revoked SESSIONS beside revoked devices. A session id
    // matches no deviceId, so it must simply find nothing.
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.record({ deviceId: 'phone' })
    expect(store.prune(['some-session-jti', 'another'])).toEqual([])
    expect(store.has('phone')).toBe(true)
  })

  it('names nothing when the file would not take the change — the phone IS still admitted', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.record({ deviceId: PHONE })
    chmodSync(temp.base, 0o500)
    try {
      // Same honesty as forget(): if the row survives, the caller must not be
      // told it was withdrawn, or the notice claims an access that still works.
      expect(store.prune([PHONE])).toEqual([])
      expect(store.has(PHONE)).toBe(true)
    } finally {
      chmodSync(temp.base, 0o700)
    }
  })
})
