import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import {
  ed25519PublicToX25519,
  ed25519SeedToX25519,
  isSealedToDevice,
  openAtDevice,
  sealToDevice
} from '../registry/src/v2-device-seal'

/**
 * SEALED TO ONE DEVICE. The property the reach handoff rests on: what cookrew.dev
 * sealed to a device's attached key opens with that device's private key and
 * with nothing else — not a second device of the same account, not a tampered
 * byte, not the registry itself.
 */

const jwks = (kind: 'ed25519' | 'ec'): { pub: Record<string, string>; priv: Record<string, string> } => {
  const pair = kind === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    pub: pair.publicKey.export({ format: 'jwk' }) as Record<string, string>,
    priv: pair.privateKey.export({ format: 'jwk' }) as Record<string, string>
  }
}

describe('Ed25519 → X25519', () => {
  it('maps a signing pair to a Diffie-Hellman pair that agrees with itself', () => {
    // If the public map and the seed map did not describe the same point, a
    // secret sealed to the mapped public key would not open with the mapped
    // seed. Two independent pairs, sealed both ways, prove the map.
    for (let i = 0; i < 8; i += 1) {
      const a = jwks('ed25519')
      const sealed = sealToDevice(a.pub, 'test', `hello ${i}`)
      expect(openAtDevice(a.priv, 'test', sealed)).toBe(`hello ${i}`)
    }
  })

  it('produces 32-byte keys either way', () => {
    const a = jwks('ed25519')
    expect(ed25519PublicToX25519(Buffer.from(a.pub.x, 'base64url'))).toHaveLength(32)
    expect(ed25519SeedToX25519(Buffer.from(a.priv.d, 'base64url'))).toHaveLength(32)
  })
})

describe('sealToDevice / openAtDevice', () => {
  it('opens only with the device it was sealed to — a second device of the account cannot read it', () => {
    const asker = jwks('ed25519')
    const other = jwks('ed25519')
    const sealed = sealToDevice(asker.pub, 'reach:r1', 'https://192.168.1.20:8643/#pair=secret')
    expect(openAtDevice(asker.priv, 'reach:r1', sealed)).toBe('https://192.168.1.20:8643/#pair=secret')
    expect(openAtDevice(other.priv, 'reach:r1', sealed)).toBeNull()
  })

  it('is bound to its label — the same bytes under another request id do not open', () => {
    const asker = jwks('ed25519')
    const sealed = sealToDevice(asker.pub, 'reach:r1', 'x')
    expect(openAtDevice(asker.priv, 'reach:r2', sealed)).toBeNull()
  })

  it('a tampered ciphertext is silence, not an exception', () => {
    const asker = jwks('ed25519')
    const sealed = sealToDevice(asker.pub, 'reach:r1', 'x')
    const flipped = { ...sealed, sealed: `${sealed.sealed.slice(0, -2)}AA` }
    expect(openAtDevice(asker.priv, 'reach:r1', flipped)).toBeNull()
    expect(openAtDevice(asker.priv, 'reach:r1', { ...sealed, e: sealed.e.replace(/^./, 'z') })).toBeNull()
  })

  it('never carries the plaintext', () => {
    const asker = jwks('ed25519')
    const sealed = sealToDevice(asker.pub, 'reach:r1', 'the-pairing-url')
    expect(JSON.stringify(sealed)).not.toContain('the-pairing-url')
    expect(sealed.alg).toBe('x25519')
    expect(isSealedToDevice(sealed)).toBe(true)
  })

  it('does the same for a P-256 device, and refuses a key this registry never admits', () => {
    const asker = jwks('ec')
    const other = jwks('ec')
    const sealed = sealToDevice(asker.pub, 'reach:r9', 'for the browser')
    expect(sealed.alg).toBe('p256')
    expect(openAtDevice(asker.priv, 'reach:r9', sealed)).toBe('for the browser')
    expect(openAtDevice(other.priv, 'reach:r9', sealed)).toBeNull()
    // A key of the wrong kind for the envelope is null too, never a throw.
    expect(openAtDevice(jwks('ed25519').priv, 'reach:r9', sealed)).toBeNull()
    expect(() => sealToDevice({ kty: 'RSA', n: 'x', e: 'AQAB' }, 'r', 'x')).toThrow()
  })

  it('reads a body shape without believing it', () => {
    expect(isSealedToDevice({ alg: 'x25519', e: 'a', sealed: 'b' })).toBe(true)
    expect(isSealedToDevice({ alg: 'rsa', e: 'a', sealed: 'b' })).toBe(false)
    expect(isSealedToDevice('nope')).toBe(false)
    expect(isSealedToDevice(null)).toBe(false)
  })
})
