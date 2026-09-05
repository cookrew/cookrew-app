import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createV2CallTokenVerifier,
  v2CallClaimsFor,
  v2SignatureHolds,
  verifyV2CallToken,
  type V2KeyMaterial,
  type V2KeySource
} from '../src/main/v2-call-token'

/**
 * THE v2 CALL TOKEN, from the door's side of the wire.
 *
 * The mint here is byte-for-byte registry/src/v2-tokens.ts — same two-part
 * format, same signature over the base64url BODY TEXT. If that ever drifts,
 * these tests fail rather than the door silently refusing every caller.
 */

const AUD = '@drej/cookrew-alpha'
const NOW = 1_780_000_000_000

function mint(
  privateKey: KeyObject,
  claims: Record<string, unknown>
): string {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  return `${body}.${sign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64url')}`
}

function keypair(): { material: V2KeyMaterial; mintCall: (over?: Record<string, unknown>) => string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  return {
    material: { jwk, revoked: [] },
    mintCall: (over = {}) =>
      mint(privateKey, {
        sub: 'mira',
        dev: 'dev-1',
        scope: 'call',
        exp: NOW + 600_000,
        jti: 'jti-1',
        aud: AUD,
        ...over
      })
  }
}

describe('a v2 call token the door accepts', () => {
  it('names the person, the device and the seat', () => {
    const { material, mintCall } = keypair()
    expect(verifyV2CallToken(mintCall({ seat: 'seat-9' }), material, AUD, NOW)).toEqual({
      username: 'mira',
      dev: 'dev-1',
      seat: 'seat-9'
    })
  })

  it('reads a missing seat as NULL, never as a wildcard', () => {
    const { material, mintCall } = keypair()
    expect(verifyV2CallToken(mintCall(), material, AUD, NOW)?.seat).toBeNull()
  })
})

describe('every shape the door refuses, and it refuses them the same way', () => {
  it('a signature from another key', () => {
    const mine = keypair()
    const theirs = keypair()
    expect(verifyV2CallToken(theirs.mintCall(), mine.material, AUD, NOW)).toBeNull()
    expect(v2SignatureHolds(theirs.mintCall(), mine.material.jwk)).toBe(false)
  })

  it('a session token spent at a door — scope must be exactly call', () => {
    const { material, mintCall } = keypair()
    expect(verifyV2CallToken(mintCall({ scope: 'session' }), material, AUD, NOW)).toBeNull()
  })

  it('a token minted for SOMEBODY ELSE"S door', () => {
    const { material, mintCall } = keypair()
    expect(verifyV2CallToken(mintCall({ aud: '@mira/review-bench' }), material, AUD, NOW)).toBeNull()
  })

  it('an expired token, judged at the moment it is presented', () => {
    const { material, mintCall } = keypair()
    const token = mintCall({ exp: NOW - 1 })
    expect(verifyV2CallToken(token, material, AUD, NOW)).toBeNull()
    expect(verifyV2CallToken(token, material, AUD, NOW - 60_000)).not.toBeNull()
  })

  it('a revoked device, and a revoked session id', () => {
    const { material, mintCall } = keypair()
    const token = mintCall()
    expect(verifyV2CallToken(token, { ...material, revoked: ['dev-1'] }, AUD, NOW)).toBeNull()
    expect(verifyV2CallToken(token, { ...material, revoked: ['jti-1'] }, AUD, NOW)).toBeNull()
    expect(verifyV2CallToken(token, { ...material, revoked: ['dev-2'] }, AUD, NOW)).not.toBeNull()
  })

  it('a seat claim that is not an id, and a sub that is not a username', () => {
    const { material, mintCall } = keypair()
    expect(verifyV2CallToken(mintCall({ seat: '' }), material, AUD, NOW)).toBeNull()
    expect(verifyV2CallToken(mintCall({ seat: true }), material, AUD, NOW)).toBeNull()
    // `acct-` is the DOOR's namespace; a registry username can never be one.
    expect(v2CallClaimsFor(mintCall({ sub: 'Mira' }), AUD, NOW)).toBeNull()
    expect(v2CallClaimsFor(mintCall({ dev: '' }), AUD, NOW)).toBeNull()
    expect(v2CallClaimsFor(mintCall({ jti: '' }), AUD, NOW)).toBeNull()
  })

  it('junk that is not a token at all', () => {
    const { material } = keypair()
    for (const junk of ['', '.', 'a.b.c', 'not-base64url', 'aGk.']) {
      expect(verifyV2CallToken(junk, material, AUD, NOW)).toBeNull()
    }
  })
})

describe('the cached key, and the one refetch', () => {
  function source(materials: (V2KeyMaterial | null)[]): { keys: V2KeySource; calls: () => number } {
    let n = 0
    return {
      keys: {
        fetch: async () => {
          const value = materials[Math.min(n, materials.length - 1)]
          n += 1
          return value
        }
      },
      calls: () => n
    }
  }

  it('fetches once and reuses the answer inside the hour', async () => {
    const { material, mintCall } = keypair()
    const { keys, calls } = source([material])
    const verifier = createV2CallTokenVerifier({ keys, now: () => NOW })
    expect(await verifier.verify(mintCall(), AUD)).not.toBeNull()
    expect(await verifier.verify(mintCall(), AUD)).not.toBeNull()
    expect(calls()).toBe(1)
  })

  it('asks again after the hour', async () => {
    const { material, mintCall } = keypair()
    const { keys, calls } = source([material])
    let clock = NOW
    const verifier = createV2CallTokenVerifier({ keys, now: () => clock })
    await verifier.verify(mintCall(), AUD)
    clock = NOW + 60 * 60 * 1000 + 1
    await verifier.verify(mintCall(), AUD)
    expect(calls()).toBe(2)
  })

  it('REFETCHES ONCE when the signature fails — a rotated key must not lock everyone out', async () => {
    const stale = keypair()
    const fresh = keypair()
    const { keys, calls } = source([stale.material, fresh.material])
    const verifier = createV2CallTokenVerifier({ keys, now: () => NOW })
    expect(await verifier.verify(fresh.mintCall(), AUD)).toEqual({
      username: 'mira',
      dev: 'dev-1',
      seat: null
    })
    expect(calls()).toBe(2)
  })

  it('REFETCHES ONCE on a revoked hit — a stale list must not outlive an un-revoke', async () => {
    const { material, mintCall } = keypair()
    const { keys, calls } = source([
      { ...material, revoked: ['dev-1'] },
      { ...material, revoked: [] }
    ])
    const verifier = createV2CallTokenVerifier({ keys, now: () => NOW })
    expect(await verifier.verify(mintCall(), AUD)).not.toBeNull()
    expect(calls()).toBe(2)
  })

  it('does NOT refetch when the claims are what failed', async () => {
    const { material, mintCall } = keypair()
    const { keys, calls } = source([material])
    const verifier = createV2CallTokenVerifier({ keys, now: () => NOW })
    expect(await verifier.verify(mintCall({ exp: NOW - 1 }), AUD)).toBeNull()
    expect(calls()).toBe(1)
  })

  it('a registry that will not answer refuses every caller, and does not throw', async () => {
    const { mintCall } = keypair()
    const verifier = createV2CallTokenVerifier({
      keys: {
        fetch: () => Promise.reject(new Error('cookrew.dev is down'))
      },
      now: () => NOW
    })
    await expect(verifier.verify(mintCall(), AUD)).resolves.toBeNull()
  })

  it('refuses a door name that is not a door', async () => {
    const { material, mintCall } = keypair()
    const { keys } = source([material])
    const verifier = createV2CallTokenVerifier({ keys, now: () => NOW })
    expect(await verifier.verify(mintCall(), 'cookrew-alpha')).toBeNull()
  })
})
