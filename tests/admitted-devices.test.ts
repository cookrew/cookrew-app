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
    store.admit({ deviceId: PHONE })
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
    store.admit({ deviceId: 'a' })
    clock = 2000
    store.admit({ deviceId: 'b' })
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
    store.admit({ deviceId: PHONE })
    expect(store.forget(PHONE)).toBe(true)
    expect(store.forget(PHONE)).toBe(true)
    expect(store.has(PHONE)).toBe(false)
  })

  it('is true for a phone this Mac never admitted', () => {
    expect(createAdmittedDeviceStore({ base: temp.base }).forget('never-here')).toBe(true)
  })

  it('is FALSE only when the file would not take the change', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    store.admit({ deviceId: PHONE })
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
