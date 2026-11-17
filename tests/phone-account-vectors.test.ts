import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { deviceIdFor } from '../src/main/account-v2'
import { jwkThumbprint } from '../src/shared/jwk-thumbprint'
import { pairTranscript } from '../src/shared/account-pair'
import { machineRelayPath } from '../src/shared/machine-relay'
import { renewMessage } from '../src/shared/session-renew'

/**
 * THE NATIVE PHONE'S ACCOUNT VECTORS (phone/core/account reads the same file).
 *
 * The Go client derives its device id, key thumbprint and pair signature on its
 * own. These are the TypeScript answers for fixed seeds, kept in a fixture, so
 * a change on either side turns one of the two suites red instead of a phone
 * silently failing to pair. PHONE_VECTORS_WRITE=1 rewrites the fixture.
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'phone-contract', 'account-vectors.json')
/** PKCS#8 DER prefix of an Ed25519 private key: the 32-byte seed follows it. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

const SEEDS = [
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'f0e1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddeeff'
] as const

const PAIR = {
  desktopId: '6c1f3a52-0e9b-4c7d-8a21-5f0d9e3b7c41',
  challengeId: '2f9d6e1a-4b3c-4d5e-9f60-718293a4b5c6',
  nonce: 'bm9uY2Utb2YtdGhpcnR5LXR3by1ieXRlcy1sb25nLiE'
} as const

/** 18 random bytes, base64url: the size registry/src/v2-renew.ts issues. */
const RENEW_NONCE = 'cmVuZXctbm9uY2UtMThieXQ'

const ROUTES = [
  'api/fleet/stream',
  '/api/terminal/t1/raw?seat=w1',
  '/~seal/hello',
  '/~seal/down?s=abc&from=3',
  '//api/x',
  'api/./x',
  'api/../etc',
  'api/a%2fb',
  'api/a%2Eb',
  'api\\x',
  'assets/app.js',
  ''
] as const

/** Machine ids the relay path refuses or folds: upper case is folded, a bad shape is refused. */
const MACHINES = [PAIR.desktopId, PAIR.desktopId.toUpperCase(), 'not-a-machine'] as const

function vectorFor(seedHex: string) {
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' })
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as Record<string, string>
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x }
  const deviceId = deviceIdFor(publicJwk)
  const transcript = pairTranscript({ ...PAIR, deviceId })
  const renew = renewMessage('alice', deviceId, RENEW_NONCE)
  return {
    seed: seedHex,
    jwk: publicJwk,
    thumbprint: jwkThumbprint(publicJwk),
    deviceId,
    pairTranscript: transcript,
    pairSig: sign(null, Buffer.from(transcript, 'utf8'), privateKey).toString('base64url'),
    renewMessage: renew,
    renewSig: sign(null, Buffer.from(renew, 'utf8'), privateKey).toString('base64url')
  }
}

function currentVectors() {
  return {
    pair: PAIR,
    renewNonce: RENEW_NONCE,
    keys: SEEDS.map(vectorFor),
    relayPaths: MACHINES.flatMap((machineId) => ROUTES.map((route) => ({ machineId, route, path: machineRelayPath(machineId, route) })))
  }
}

describe('native phone account vectors', () => {
  it('match the fixture the Go client tests against', () => {
    const vectors = currentVectors()
    if (process.env.PHONE_VECTORS_WRITE === '1') {
      mkdirSync(path.dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, `${JSON.stringify(vectors, null, 2)}\n`)
    }
    // Never written behind a test's back: a missing fixture fails, so it can't pass by comparing with itself.
    expect(existsSync(FIXTURE), `${FIXTURE} is missing; PHONE_VECTORS_WRITE=1 writes it`).toBe(true)
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(vectors)
  })
})
