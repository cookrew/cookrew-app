// ONE DECISION ABOUT A PRESENTED CREDENTIAL (v3, V3-21).
//
// The root pairing token opens the admission route and nothing else; a
// per-device token opens everything; a revoked (pruned) or forgotten phone's
// token opens nothing; and rotating the root stops nobody who is admitted.
// The migration flag keeps the root honoured everywhere until the companion
// bootstraps (V3-14) — and it is a flag, so this file can pin both worlds.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAdmittedDeviceStore } from '../src/main/admitted-devices'
import { companionAccepted, companionCredential } from '../src/main/companion-gate'
import { tempBase } from './support/idv2'

const ROOT = 'the-root-pairing-token-abcdefgh'
const PHONE_A = 'aaaaaaaa-1111-8222-8333-444444444444'
const PHONE_B = 'bbbbbbbb-1111-8222-8333-444444444444'

describe('the root token is a bootstrap credential', () => {
  const never = (): boolean => false

  it('opens the admission route, and nothing else, in strict mode', () => {
    expect(
      companionCredential({ route: 'admission', presented: ROOT, rootToken: ROOT, perDevice: never, rootEverywhere: false }),
    ).toBe('root')
    expect(
      companionCredential({ route: 'other', presented: ROOT, rootToken: ROOT, perDevice: never, rootEverywhere: false }),
    ).toBeNull()
  })

  it('still opens every route while the companion has not bootstrapped (rootEverywhere)', () => {
    expect(
      companionCredential({ route: 'other', presented: ROOT, rootToken: ROOT, perDevice: never, rootEverywhere: true }),
    ).toBe('root')
  })

  it('refuses a near miss, an empty credential and a server with no token yet', () => {
    for (const presented of [`${ROOT}x`, ROOT.slice(1), '', null]) {
      expect(
        companionCredential({ route: 'admission', presented, rootToken: ROOT, perDevice: never, rootEverywhere: true }),
      ).toBeNull()
    }
    expect(
      companionCredential({ route: 'admission', presented: ROOT, rootToken: null, perDevice: never, rootEverywhere: true }),
    ).toBeNull()
  })
})

describe('a per-device token opens everything, and only for its phone', () => {
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  it('is accepted on every route, strict or not, and is never mistaken for the root', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    const { token } = store.admit({ deviceId: PHONE_A, name: 'iPhone' })
    for (const route of ['admission', 'other'] as const) {
      for (const rootEverywhere of [true, false]) {
        expect(
          companionCredential({ route, presented: token, rootToken: ROOT, perDevice: store.accepts, rootEverywhere }),
        ).toBe('device')
      }
    }
  })

  it('REVOKED = PRUNED = REFUSED: the registry names the phone, the token dies', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    const a = store.admit({ deviceId: PHONE_A, name: 'iPhone' }).token
    const b = store.admit({ deviceId: PHONE_B, name: 'iPad' }).token
    const gate = (presented: string): boolean =>
      companionAccepted({ route: 'other', presented, rootToken: ROOT, perDevice: store.accepts, rootEverywhere: false })
    expect(gate(a)).toBe(true)
    expect(gate(b)).toBe(true)
    // What V3-05 does within a minute of a revoke at the registry.
    expect(store.prune([PHONE_A, 'some-session-jti']).map((d) => d.deviceId)).toEqual([PHONE_A])
    expect(gate(a)).toBe(false)
    // The second admitted phone keeps working — e2e step 11.
    expect(gate(b)).toBe(true)
  })

  it('FORGET ends it the same way', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    const a = store.admit({ deviceId: PHONE_A }).token
    expect(store.forget(PHONE_A)).toBe(true)
    expect(
      companionAccepted({ route: 'other', presented: a, rootToken: ROOT, perDevice: store.accepts, rootEverywhere: true }),
    ).toBe(false)
  })

  it('ROTATING THE ROOT STOPS NOBODY WHO IS ADMITTED — only whoever has not bootstrapped', () => {
    const store = createAdmittedDeviceStore({ base: temp.base })
    const a = store.admit({ deviceId: PHONE_A }).token
    const rotated = 'a-freshly-rotated-root-token-xyz'
    // The admitted phone: still in, on the new root, in either mode.
    for (const rootEverywhere of [true, false]) {
      expect(
        companionAccepted({ route: 'other', presented: a, rootToken: rotated, perDevice: store.accepts, rootEverywhere }),
      ).toBe(true)
    }
    // A phone still holding the OLD root: out, as rotation has always meant.
    expect(
      companionAccepted({ route: 'other', presented: ROOT, rootToken: rotated, perDevice: store.accepts, rootEverywhere: true }),
    ).toBe(false)
    expect(
      companionAccepted({ route: 'admission', presented: ROOT, rootToken: rotated, perDevice: store.accepts, rootEverywhere: true }),
    ).toBe(false)
  })
})
