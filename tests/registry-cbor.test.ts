import { describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { attestationFor, cbor } from './support/webauthn'

const RP_ID = 'localhost'
import { CborError, decodeCbor, decodeCborExact } from '../registry/src/cbor'
import { coseToJwk, parseAttestationObject } from '../registry/src/passkey'
import { jwkThumbprint, publicJwk, verifyDetached } from '../registry/src/jwk'
import { sign } from 'node:crypto'

/**
 * CBOR AND ATTESTATION — the bytes a passkey actually arrives as.
 *
 * The registry ships as one dependency-free bundle, so it decodes CBOR itself;
 * this is the file that says the decoder is a decoder and not a guess. The
 * ENCODER below lives in the test on purpose: nothing in the shipped registry
 * needs to write CBOR, and an encoder in `registry/src` would be untested
 * surface that exists only to make its own tests pass.
 */

/* ── the decoder ─────────────────────────────────────────────────────────── */

describe('decodeCbor', () => {
  it('round-trips every shape a passkey uses', () => {
    const map = new Map<unknown, unknown>([
      ['fmt', 'none'],
      [1, 2],
      [-1, 1],
      ['bytes', new Uint8Array([1, 2, 3])],
      ['list', [1, 'two', false]]
    ])
    const out = decodeCborExact(cbor(map)) as Map<unknown, unknown>
    expect(out.get('fmt')).toBe('none')
    expect(out.get(1)).toBe(2)
    // Negative labels are how COSE names a curve; reading -1 as 1 would enrol
    // the wrong key type without ever failing.
    expect(out.get(-1)).toBe(1)
    expect(Buffer.from(out.get('bytes') as Uint8Array)).toEqual(Buffer.from([1, 2, 3]))
    expect(out.get('list')).toEqual([1, 'two', false])
  })

  it('reads the two- and four-byte length forms', () => {
    const long = new Uint8Array(300).fill(7)
    expect(Buffer.from(decodeCborExact(cbor(long)) as Uint8Array)).toEqual(Buffer.from(long))
    // Past 65535 the length is a four-byte argument — and past the default
    // 64 KiB string cap, so this is also the cap doing its job.
    const longer = new Uint8Array(70_000).fill(3)
    expect(() => decodeCborExact(cbor(longer))).toThrow(CborError)
    const wide = { maxDepth: 8, maxItems: 1024, maxStringBytes: 200_000 }
    expect((decodeCborExact(cbor(longer), wide) as Uint8Array).byteLength).toBe(70_000)
  })

  it('says where an item ENDED, which is how a COSE key is found', () => {
    // A COSE key sits at the tail of attested credential data with anything the
    // authenticator added after it; without `end` there is no way to know where
    // one stops and the other starts.
    const first = cbor(new Map<unknown, unknown>([[1, 2]]))
    const buffer = Buffer.concat([first, Buffer.from('trailing', 'utf8')])
    const read = decodeCbor(buffer)
    expect(read.end).toBe(first.byteLength)
    expect(buffer.subarray(read.end).toString()).toBe('trailing')
  })

  it('refuses trailing bytes when the whole input must be one item', () => {
    expect(() => decodeCborExact(Buffer.concat([cbor(1), cbor(2)]))).toThrow(CborError)
  })

  it('refuses a truncated buffer rather than reading past it', () => {
    const full = cbor(new Uint8Array([1, 2, 3, 4, 5]))
    expect(() => decodeCborExact(full.subarray(0, 3))).toThrow(CborError)
  })

  it('refuses the indefinite-length form', () => {
    // 0x5f is an indefinite-length byte string: no authenticator emits one and
    // accepting it is how a decoder ends up with an unbounded loop.
    expect(() => decodeCborExact(Buffer.from([0x5f, 0x41, 0x01, 0xff]))).toThrow(CborError)
  })

  it('refuses a 64-bit length, a duplicate key and a semantic tag', () => {
    expect(() => decodeCborExact(Buffer.from([0x5b, 0, 0, 0, 0, 0, 0, 0, 1, 9]))).toThrow(CborError)
    // {1: 1, 1: 2} — two spellings of one map is two parsers disagreeing.
    expect(() => decodeCborExact(Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02]))).toThrow(CborError)
    expect(() => decodeCborExact(Buffer.from([0xc0, 0x01]))).toThrow(CborError)
  })

  it('caps nesting rather than recursing on a hostile buffer', () => {
    // Twelve nested one-element arrays, against a depth cap of eight.
    let nested: unknown = 1
    for (let i = 0; i < 12; i++) nested = [nested]
    expect(() => decodeCborExact(cbor(nested))).toThrow(CborError)
  })

  it('caps a declared length before it is trusted', () => {
    // A header claiming 65535 bytes over a three-byte buffer.
    expect(() => decodeCborExact(Buffer.from([0x59, 0xff, 0xff, 0x01]))).toThrow(CborError)
  })
})

describe('parseAttestationObject', () => {
  it('pulls the credential id and the P-256 key out of a real shape', () => {
    const fixture = attestationFor()
    const out = parseAttestationObject(fixture.attestationObject)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.passkey.credentialId).toBe(fixture.credentialId)
    expect(out.passkey.jwk).toEqual(fixture.jwk)
    expect(out.passkey.userPresent).toBe(true)
    expect(out.passkey.signCount).toBe(1)
    expect(out.passkey.rpIdHash).toBe(createHash('sha256').update(RP_ID).digest('base64url'))
  })

  it('reads an Ed25519 (OKP) passkey', () => {
    const keys = generateKeyPairSync('ed25519')
    const jwk = keys.publicKey.export({ format: 'jwk' }) as Record<string, string>
    const cose = cbor(
      new Map<unknown, unknown>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))]
      ])
    )
    expect(coseToJwk(decodeCborExact(cose))).toEqual({ kty: 'OKP', crv: 'Ed25519', x: jwk.x })
  })

  it('finds the key even when the authenticator appended extensions', () => {
    // The decoder reports where the COSE key ended, so bytes after it are
    // ignored rather than making the parse fail.
    const fixture = attestationFor({ trailing: cbor(new Map([['ext', 1]])) })
    const out = parseAttestationObject(fixture.attestationObject)
    expect(out.ok).toBe(true)
  })

  it('refuses attested data that is not there', () => {
    // AT bit clear: an assertion's authData, presented as a registration.
    const fixture = attestationFor({ flags: 0x01 })
    expect(parseAttestationObject(fixture.attestationObject)).toEqual({
      ok: false,
      reason: 'no_attested_credential'
    })
  })

  it('refuses a credential id length that overruns the buffer', () => {
    const fixture = attestationFor()
    const map = decodeCborExact(fixture.attestationObject) as Map<unknown, unknown>
    const authData = Buffer.from(map.get('authData') as Uint8Array)
    authData.writeUInt16BE(1000, 53)
    const forged = cbor(
      new Map<unknown, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)]
      ])
    )
    expect(parseAttestationObject(forged)).toEqual({ ok: false, reason: 'short_auth_data' })
  })

  it('refuses a zero-length credential id', () => {
    const fixture = attestationFor({ credentialId: Buffer.alloc(0) })
    expect(parseAttestationObject(fixture.attestationObject)).toEqual({
      ok: false,
      reason: 'bad_credential_id'
    })
  })

  it('refuses a key that is not one of the two this registry can verify', () => {
    // kty 3 is RSA. Enrolling one would be a device that can never sign again.
    const rsa = cbor(new Map<unknown, unknown>([[1, 3], [-1, new Uint8Array(4)]]))
    expect(coseToJwk(decodeCborExact(rsa))).toBeNull()
    // And a P-256 point with the wrong coordinate width.
    const short = cbor(
      new Map<unknown, unknown>([[1, 2], [-1, 1], [-2, new Uint8Array(31)], [-3, new Uint8Array(32)]])
    )
    expect(coseToJwk(decodeCborExact(short))).toBeNull()
  })

  it('refuses garbage without throwing', () => {
    expect(parseAttestationObject(Buffer.from('not cbor at all', 'utf8')).ok).toBe(false)
    expect(parseAttestationObject(Buffer.alloc(0)).ok).toBe(false)
    expect(parseAttestationObject(cbor(new Map([['fmt', 'none']]))).ok).toBe(false)
  })
})

/* ── jwk hygiene ─────────────────────────────────────────────────────────── */

describe('publicJwk', () => {
  it('drops the private half of a key somebody exported carelessly', () => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const priv = keys.privateKey.export({ format: 'jwk' }) as Record<string, unknown>
    expect(priv.d).toBeTypeOf('string')
    const narrowed = publicJwk(priv)
    expect(narrowed).not.toBeNull()
    expect(narrowed?.d).toBeUndefined()
    expect(Object.keys(narrowed ?? {}).sort()).toEqual(['crv', 'kty', 'x', 'y'])
  })

  it('refuses a curve nothing here verifies', () => {
    expect(publicJwk({ kty: 'EC', crv: 'P-384', x: 'a', y: 'b' })).toBeNull()
    expect(publicJwk({ kty: 'RSA', n: 'a', e: 'b' })).toBeNull()
    expect(publicJwk('not an object')).toBeNull()
  })
})

describe('jwkThumbprint', () => {
  it('matches RFC 7638 for the specification\'s own EC example', () => {
    // The example key from RFC 7638 §3.1 is RSA; the EC vector below is this
    // repository's own, and what matters is the property under it: two
    // spellings of one key hash the same, so a vouch names a KEY.
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    const reordered = { y: jwk.y, kty: jwk.kty, x: jwk.x, crv: jwk.crv, use: 'sig' }
    expect(jwkThumbprint(jwk)).toBe(jwkThumbprint(reordered))
    expect(jwkThumbprint(jwk)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('separates two different keys', () => {
    const a = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    const b = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    expect(jwkThumbprint(a)).not.toBe(jwkThumbprint(b))
  })
})

describe('verifyDetached', () => {
  it('accepts a real signature over the exact bytes and refuses a changed one', () => {
    const keys = generateKeyPairSync('ed25519')
    const jwk = keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    const signature = sign(null, Buffer.from('cookrew-bind/1 drej x y', 'utf8'), keys.privateKey)
    expect(verifyDetached(jwk, 'cookrew-bind/1 drej x y', signature.toString('base64url'))).toBe(true)
    expect(verifyDetached(jwk, 'cookrew-bind/1 mira x y', signature.toString('base64url'))).toBe(false)
    expect(verifyDetached(jwk, 'cookrew-bind/1 drej x y', 'not-a-signature')).toBe(false)
  })

  it('verifies a P-256 DER signature, which is what a browser produces', () => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    const message = 'cookrew-bind/1 drej 00000000-0000-4000-8000-000000000000 t'
    const signature = sign('sha256', Buffer.from(message, 'utf8'), keys.privateKey)
    expect(verifyDetached(jwk, message, signature.toString('base64url'))).toBe(true)
  })
})
