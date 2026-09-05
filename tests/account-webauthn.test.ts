// THE PASSKEY CEREMONY'S TWO SHAPES — JSON on the wire, buffers in the
// browser — and the question the desktop actually has to answer: was that a
// refusal I should route around, or a failure I should report?
//
// This is tested without a platform authenticator on purpose. The machine
// this runs on may have none, and a conversion bug that only appears on
// hardware is a bug nobody sees until an owner cannot enrol.

import { afterEach, describe, expect, it } from 'vitest'
import {
  cannotMakePasskey,
  hasPlatformAuthenticator,
  fromBase64Url,
  fromCredential,
  toBase64Url,
  toCreationOptions,
} from '../src/renderer/src/account/webauthn'

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)

describe('base64url, both ways', () => {
  it('round-trips bytes that need every escape', () => {
    const raw = bytes(251, 255, 190, 0, 1, 62, 63)
    const encoded = toBase64Url(raw)
    expect(encoded).not.toMatch(/[+/=]/)
    expect([...fromBase64Url(encoded)]).toEqual([...raw])
  })

  it('accepts a challenge that arrived without padding', () => {
    // The wire says unpadded; a decoder that insists on padding refuses every
    // real challenge.
    expect([...fromBase64Url('AQID')]).toEqual([1, 2, 3])
    expect([...fromBase64Url('AQI')]).toEqual([1, 2])
    expect([...fromBase64Url('')]).toEqual([])
  })

  it('hands the DOM a plain buffer, which is the only kind it takes', () => {
    expect(fromBase64Url('AQID').buffer).toBeInstanceOf(ArrayBuffer)
  })
})

describe('the creation options', () => {
  const raw = {
    challenge: 'AQID',
    rp: { id: 'registry.test', name: 'Cookrew' },
    user: { id: 'BAUG', name: 'drej', displayName: 'drej' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { userVerification: 'required' },
    excludeCredentials: [{ id: 'BwgJ', type: 'public-key' }],
    timeout: 60_000,
  }

  it('decodes exactly the three fields that are bytes', () => {
    const options = toCreationOptions(raw)
    expect([...new Uint8Array(options.challenge as ArrayBuffer)]).toEqual([1, 2, 3])
    expect([...new Uint8Array(options.user.id as ArrayBuffer)]).toEqual([4, 5, 6])
    expect([...new Uint8Array(options.excludeCredentials?.[0].id as ArrayBuffer)]).toEqual([7, 8, 9])
  })

  it('carries everything else through untouched', () => {
    const options = toCreationOptions(raw)
    // Nothing is "helpfully" filled in or relaxed: what the authenticator
    // binds the key to is the registry's business, not this renderer's.
    expect(options.rp).toEqual({ id: 'registry.test', name: 'Cookrew' })
    expect(options.authenticatorSelection).toEqual({ userVerification: 'required' })
    expect(options.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }])
    expect(options.timeout).toBe(60_000)
    expect(options.user.name).toBe('drej')
  })

  it('does not invent an excludeCredentials list when there was none', () => {
    expect(toCreationOptions({ challenge: 'AQID', user: { id: 'BAUG' } }).excludeCredentials).toBe(
      undefined,
    )
  })
})

describe('the credential, on its way back', () => {
  it('re-encodes the buffers and keeps the id and the type', () => {
    const credential = {
      id: 'abc',
      rawId: bytes(1, 2, 3).buffer,
      type: 'public-key',
      response: {
        clientDataJSON: bytes(4, 5, 6).buffer,
        attestationObject: bytes(7, 8, 9).buffer,
      },
    } as unknown as PublicKeyCredential
    expect(fromCredential(credential)).toEqual({
      id: 'abc',
      rawId: 'AQID',
      type: 'public-key',
      response: { clientDataJSON: 'BAUG', attestationObject: 'BwgJ' },
    })
  })
})

describe('what a refusal means', () => {
  const globals = globalThis as unknown as { PublicKeyCredential?: unknown }
  afterEach(() => {
    delete globals.PublicKeyCredential
  })

  it('a build with no WebAuthn at all is answered by the browser row', () => {
    expect(cannotMakePasskey(new Error('anything'))).toBe(true)
  })

  it('sends the owner to a browser for the three refusals Electron gives', () => {
    globals.PublicKeyCredential = class {}
    for (const name of ['NotSupportedError', 'NotAllowedError', 'SecurityError']) {
      expect(cannotMakePasskey(Object.assign(new Error('no'), { name }))).toBe(true)
    }
  })

  it('does NOT swallow a real failure as "use a browser"', () => {
    globals.PublicKeyCredential = class {}
    expect(cannotMakePasskey(Object.assign(new Error('boom'), { name: 'TypeError' }))).toBe(false)
    expect(cannotMakePasskey(null)).toBe(false)
  })
})

describe('is there a Touch ID here at all', () => {
  const globals = globalThis as unknown as { PublicKeyCredential?: unknown }
  afterEach(() => {
    delete globals.PublicKeyCredential
  })

  it('is no when the build has no WebAuthn', async () => {
    await expect(hasPlatformAuthenticator()).resolves.toBe(false)
  })

  it('asks the browser, and takes its answer', async () => {
    globals.PublicKeyCredential = { isUserVerifyingPlatformAuthenticatorAvailable: async () => true }
    await expect(hasPlatformAuthenticator()).resolves.toBe(true)
    globals.PublicKeyCredential = {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
    }
    await expect(hasPlatformAuthenticator()).resolves.toBe(false)
  })

  it('is no — never a thrown boot — when the question itself fails', async () => {
    globals.PublicKeyCredential = {
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.reject(new Error('nope')),
    }
    await expect(hasPlatformAuthenticator()).resolves.toBe(false)
  })
})
