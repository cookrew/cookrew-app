import type http from 'node:http'
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAdmittedDeviceStore } from '../src/main/admitted-devices'
import { verifyWithDevice } from '../src/main/account-v2'
import { helloAnswerV2 } from '../src/main/device-hello'
import { HELLO_V2_CONTEXT, helloMessageV2, publishedRequestOrigin } from '../src/shared/hello-proof'
import { handleIdentityRoutes, type MobileIdentityDeps } from '../src/main/mobile-identity-routes'
import { fakeAccount, tempBase } from './support/idv2'

/**
 * THE MAC SIGNS WHAT IT SAW.
 *
 * The hole version 2 closes: a box on the LAN that gets a name pointed at
 * itself takes the phone's challenge, forwards it to the real Mac, and returns
 * the real Mac's signature. Version 1 has no way to notice — the device id is
 * right, the nonce is right, the key is right.
 *
 * So the only thing that matters in this file is that the ORIGIN in the
 * signature is the one the request actually arrived at, and that nothing a
 * caller sends can change it: not `?origin=`, not a Host this Mac never
 * published, not a scheme it is not listening on.
 */

const NOW = 1_800_000_000_000
const REGISTRY = 'https://cookrew.dev'
const HOST = 'mac.example.test:8643'
const ORIGIN = `https://${HOST}`
const nonce = randomBytes(32).toString('base64url')

const account = fakeAccount()

describe('the signed message', () => {
  it('is the context, the device, the ORIGIN, the time and the nonce', () => {
    expect(HELLO_V2_CONTEXT).toBe('cookrew-hello/2')
    expect(helloMessageV2('dev', ORIGIN, NOW, 'n')).toBe(
      `cookrew-hello/2 dev ${ORIGIN} ${NOW} n`
    )
  })

  it('signs the origin the Mac saw, and the key verifies exactly that string', () => {
    const answer = helloAnswerV2({ account, nonce, asked: ORIGIN, arrived: ORIGIN, now: NOW })
    expect(answer.status).toBe(200)
    if (answer.status !== 200) return
    expect(answer.body.v).toBe(2)
    expect(answer.body.origin).toBe(ORIGIN)
    expect(answer.body.issuedAtMs).toBe(NOW)
    expect(
      verifyWithDevice(
        account.publicKeyJwk,
        helloMessageV2(account.deviceId, ORIGIN, NOW, nonce),
        answer.body.sig
      )
    ).toBe(true)
  })

  it('THE ATTACK: the same signature does not verify for a different origin', () => {
    // This is what a relay hands back — a real signature, made at the real
    // Mac's address, presented as though it were made at the attacker's.
    const answer = helloAnswerV2({ account, nonce, asked: null, arrived: ORIGIN, now: NOW })
    if (answer.status !== 200) return
    expect(
      verifyWithDevice(
        account.publicKeyJwk,
        helloMessageV2(account.deviceId, 'https://192.168.1.99:8643', NOW, nonce),
        answer.body.sig
      )
    ).toBe(false)
  })

  it('signs a different string for a different port on the same host', () => {
    const eight = helloAnswerV2({ account, nonce, asked: null, arrived: ORIGIN, now: NOW })
    const plain = helloAnswerV2({
      account,
      nonce,
      asked: null,
      arrived: 'https://mac.example.test',
      now: NOW
    })
    if (eight.status !== 200 || plain.status !== 200) return
    expect(eight.body.sig).not.toBe(plain.body.sig)
  })

  it('signs a different string a second later, so a capture ages', () => {
    const first = helloAnswerV2({ account, nonce, asked: null, arrived: ORIGIN, now: NOW })
    const later = helloAnswerV2({ account, nonce, asked: null, arrived: ORIGIN, now: NOW + 1000 })
    if (first.status !== 200 || later.status !== 200) return
    expect(first.body.sig).not.toBe(later.body.sig)
  })
})

describe('what it refuses to sign', () => {
  it('is 421 when the request did not arrive at a name this Mac published', () => {
    const answer = helloAnswerV2({ account, nonce, asked: ORIGIN, arrived: null, now: NOW })
    expect(answer.status).toBe(421)
  })

  it("is 421 when the caller's ?origin= is not where the request landed", () => {
    const answer = helloAnswerV2({
      account,
      nonce,
      asked: 'https://192.168.1.99:8643',
      arrived: ORIGIN,
      now: NOW
    })
    expect(answer.status).toBe(421)
  })

  it('accepts the two spellings of the same default port as one origin', () => {
    const answer = helloAnswerV2({
      account,
      nonce,
      asked: 'https://mac.example.test:443',
      arrived: 'https://mac.example.test',
      now: NOW
    })
    expect(answer.status).toBe(200)
  })

  it('is 404 with no account and 400 for a nonce out of bounds', () => {
    expect(helloAnswerV2({ account: null, nonce, asked: null, arrived: ORIGIN, now: NOW }).status)
      .toBe(404)
    expect(
      helloAnswerV2({
        account,
        nonce: randomBytes(8).toString('base64url'),
        asked: null,
        arrived: ORIGIN,
        now: NOW
      }).status
    ).toBe(400)
  })
})

describe('the origin the server believes', () => {
  const published = ['https://mac.example.test:8643', 'http://localhost:8639']

  it('is the listener scheme plus the Host, when the Host is one of ours', () => {
    expect(publishedRequestOrigin('mac.example.test:8643', true, published)).toBe(ORIGIN)
    expect(publishedRequestOrigin('localhost:8639', false, published)).toBe('http://localhost:8639')
  })

  it('is null for a Host this Mac never published — the shape of a rebound name', () => {
    expect(publishedRequestOrigin('evil.example', true, published)).toBe(null)
    expect(publishedRequestOrigin('mac.example.test:9999', true, published)).toBe(null)
    // Same name, wrong scheme: a plaintext listener is not the https origin.
    expect(publishedRequestOrigin('mac.example.test:8643', false, published)).toBe(null)
  })

  it('is null when this Mac cannot say what it published at all', () => {
    expect(publishedRequestOrigin('mac.example.test:8643', true, [])).toBe(null)
  })

  it('refuses a Host carrying anything but a host and a port', () => {
    for (const host of ['mac.example.test:8643/x', 'mac.example.test:8643, evil', 'a b', '', undefined]) {
      expect(publishedRequestOrigin(host, true, published), String(host)).toBe(null)
    }
  })
})

describe('GET /api/hello over the wire', () => {
  let temp: { base: string; clean: () => void }
  beforeEach(() => (temp = tempBase()))
  afterEach(() => temp.clean())

  const deps = (over: Partial<MobileIdentityDeps> = {}): MobileIdentityDeps => ({
    account: () => account,
    registryOrigin: () => REGISTRY,
    admitted: createAdmittedDeviceStore({ base: temp.base }),
    selfOrigins: () => [ORIGIN],
    now: () => NOW,
    ...over
  })

  const recorder = () => {
    const written = { status: 0, headers: {} as Record<string, string>, body: '' }
    const response = {
      writeHead: (status: number, headers?: Record<string, string>) => {
        written.status = status
        written.headers = { ...written.headers, ...(headers ?? {}) }
        return response
      },
      setHeader: (name: string, value: string) => void (written.headers[name] = value),
      end: (chunk?: string) => void (written.body += chunk ?? ''),
      getHeader: (name: string) => written.headers[name]
    }
    return { written, response: response as unknown as http.ServerResponse }
  }

  const ask = async (query: string, host = HOST, over: Partial<MobileIdentityDeps> = {}) => {
    const { written, response } = recorder()
    const request = {
      method: 'GET',
      headers: { origin: REGISTRY, host },
      socket: { encrypted: true, remoteAddress: '192.168.1.9' }
    } as unknown as http.IncomingMessage
    await handleIdentityRoutes(request, response, new URL(`https://${host}/api/hello${query}`), deps(over))
    return { status: written.status, body: written.body === '' ? {} : JSON.parse(written.body) }
  }

  it('answers version 2 when the caller sends the origin it dialled', async () => {
    const answered = await ask(`?nonce=${nonce}&origin=${encodeURIComponent(ORIGIN)}`)
    expect(answered.status).toBe(200)
    expect(answered.body.v).toBe(2)
    expect(answered.body.origin).toBe(ORIGIN)
    expect(
      verifyWithDevice(
        account.publicKeyJwk,
        helloMessageV2(account.deviceId, ORIGIN, NOW, nonce),
        answered.body.sig
      )
    ).toBe(true)
  })

  it('answers 421 for a Host this Mac never published, however right the query is', async () => {
    const answered = await ask(
      `?nonce=${nonce}&origin=${encodeURIComponent('https://evil.example')}`,
      'evil.example'
    )
    expect(answered.status).toBe(421)
  })

  it('answers version 1 unchanged to a phone that sends no origin', async () => {
    const answered = await ask(`?nonce=${nonce}`)
    expect(answered.status).toBe(200)
    expect(answered.body.v).toBeUndefined()
    expect(answered.body.origin).toBeUndefined()
    expect(answered.body.deviceId).toBe(account.deviceId)
  })

  it('does not Host-pin version 1 — an old phone keeps working', async () => {
    const answered = await ask(`?nonce=${nonce}`, 'somewhere.else.test')
    expect(answered.status).toBe(200)
  })
})
