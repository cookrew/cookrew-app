import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyWithDevice } from '../src/main/account-v2'
import {
  HELLO_CONTEXT,
  NONCE_MAX_BYTES,
  NONCE_MIN_BYTES,
  helloAnswer,
  helloCorsHeaders,
  helloMessage,
  nonceAcceptable,
  nonceBytes
} from '../src/main/device-hello'
import { fakeAccount } from './support/idv2'

const nonceOf = (bytes: number): string => randomBytes(bytes).toString('base64url')

describe('hello signature', () => {
  const account = fakeAccount()

  it('signs exactly the context, the device id and the nonce', () => {
    const nonce = nonceOf(16)
    expect(helloMessage(account.deviceId, nonce)).toBe(
      `${HELLO_CONTEXT} ${account.deviceId} ${nonce}`
    )
    expect(HELLO_CONTEXT).toBe('cookrew-hello/1')
  })

  it('answers with a signature the public key verifies', () => {
    const nonce = nonceOf(32)
    const answer = helloAnswer(account, nonce)
    expect(answer.status).toBe(200)
    if (answer.status !== 200) return
    expect(answer.body.deviceId).toBe(account.deviceId)
    expect(answer.body.name).toBe('MacBook Pro')
    expect(answer.body.nonce).toBe(nonce)
    expect(
      verifyWithDevice(
        account.publicKeyJwk,
        helloMessage(account.deviceId, nonce),
        answer.body.sig
      )
    ).toBe(true)
  })

  it('will not verify against a different nonce, so a reply cannot be replayed', () => {
    const answer = helloAnswer(account, nonceOf(16))
    expect(answer.status).toBe(200)
    if (answer.status !== 200) return
    expect(
      verifyWithDevice(account.publicKeyJwk, helloMessage(account.deviceId, nonceOf(16)), answer.body.sig)
    ).toBe(false)
  })

  it('will not verify against another desktop key', () => {
    const nonce = nonceOf(16)
    const answer = helloAnswer(account, nonce)
    const stranger = fakeAccount()
    if (answer.status !== 200) return
    expect(
      verifyWithDevice(stranger.publicKeyJwk, helloMessage(account.deviceId, nonce), answer.body.sig)
    ).toBe(false)
  })

  it('signs a different string for a different device id', () => {
    expect(helloMessage('a', 'n')).not.toBe(helloMessage('b', 'n'))
  })
})

describe('hello nonce bounds', () => {
  it('accepts 16 through 64 bytes', () => {
    expect(NONCE_MIN_BYTES).toBe(16)
    expect(NONCE_MAX_BYTES).toBe(64)
    for (const bytes of [16, 17, 32, 63, 64]) {
      expect(nonceAcceptable(nonceOf(bytes)), `${bytes} bytes`).toBe(true)
    }
  })

  it('refuses a nonce that is too short or too long', () => {
    for (const bytes of [1, 8, 15, 65, 128]) {
      expect(nonceAcceptable(nonceOf(bytes)), `${bytes} bytes`).toBe(false)
    }
  })

  it('refuses anything that is not strict base64url', () => {
    expect(nonceBytes('not base64!')).toBeNull()
    expect(nonceBytes('a+b/c=')).toBeNull()
    expect(nonceBytes(`${nonceOf(16)}=`)).toBeNull()
    expect(nonceBytes('')).toBeNull()
  })

  it('answers 400 for a missing or unacceptable nonce', () => {
    const account = fakeAccount()
    expect(helloAnswer(account, null).status).toBe(400)
    expect(helloAnswer(account, '').status).toBe(400)
    expect(helloAnswer(account, nonceOf(8)).status).toBe(400)
    expect(helloAnswer(account, nonceOf(65)).status).toBe(400)
  })
})

describe('hello without an account', () => {
  it('is 404, because there is no identity to assert yet', () => {
    const answer = helloAnswer(null, nonceOf(32))
    expect(answer.status).toBe(404)
  })

  it('is 404 even for a bad nonce — the absent account is the first fact', () => {
    expect(helloAnswer(null, 'nope!').status).toBe(404)
  })
})

describe('hello cors', () => {
  const registry = 'https://cookrew.dev'

  it('echoes exactly the registry origin, and never a wildcard', () => {
    const headers = helloCorsHeaders(registry, registry)
    expect(headers['access-control-allow-origin']).toBe(registry)
    expect(Object.values(headers)).not.toContain('*')
  })

  it('answers the preflight verbs', () => {
    const headers = helloCorsHeaders(registry, registry)
    expect(headers['access-control-allow-methods']).toBe('GET, OPTIONS')
    expect(headers['access-control-max-age']).toBe('600')
  })

  it('never allows credentials, so no cookie rides along', () => {
    const headers = helloCorsHeaders(registry, registry)
    expect(headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('says nothing at all to any other origin', () => {
    for (const origin of ['https://evil.example', 'http://cookrew.dev', 'null', undefined]) {
      const headers = helloCorsHeaders(origin, registry)
      expect(headers['access-control-allow-origin'], String(origin)).toBeUndefined()
    }
  })

  it("lets this Mac's own other addresses read it, for the live path switch", () => {
    const tailnet = 'https://100.68.81.64:8643'
    const lan = 'https://192.168.1.24:8643'
    // A companion served over the tailnet asking a LAN address of the SAME Mac
    // whether it is the same Mac. Without this the answer is unreadable and
    // the phone can never learn the faster path is there.
    const headers = helloCorsHeaders(tailnet, registry, [lan, tailnet])
    expect(headers['access-control-allow-origin']).toBe(tailnet)
    expect(headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('still says nothing to an address this Mac does not answer on', () => {
    const headers = helloCorsHeaders('https://192.168.1.99:8643', registry, [
      'https://192.168.1.24:8643'
    ])
    expect(headers['access-control-allow-origin']).toBeUndefined()
  })

  it('always varies on origin, so a proxy cannot cache one answer for all', () => {
    expect(helloCorsHeaders(undefined, registry).vary).toBe('origin')
    expect(helloCorsHeaders(registry, registry).vary).toBe('origin')
  })

  it('honours a self-hosted registry origin', () => {
    const local = 'https://reg.example.test'
    expect(helloCorsHeaders(local, local)['access-control-allow-origin']).toBe(local)
    expect(helloCorsHeaders('https://cookrew.dev', local)['access-control-allow-origin'])
      .toBeUndefined()
  })
})
