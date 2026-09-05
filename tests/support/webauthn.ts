import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'

/**
 * WEBAUTHN FIXTURES — the bytes an authenticator would have produced.
 *
 * Shared by the CBOR tests and the account routes' tests, and deliberately not
 * in `registry/src`: nothing the registry ships needs to WRITE CBOR or sign an
 * attestation, and an encoder living next to the decoder would be untested
 * surface whose only purpose is making its own tests pass.
 */

/* ── a tiny CBOR encoder, for fixtures only ──────────────────────────────── */

const head = (major: number, value: number): Buffer => {
  if (value < 24) return Buffer.from([(major << 5) | value])
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value])
  if (value < 0x10000) return Buffer.from([(major << 5) | 25, value >> 8, value & 0xff])
  return Buffer.from([
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ])
}

export function cbor(value: unknown): Buffer {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 0 ? head(0, value) : head(1, -1 - value)
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([head(3, bytes.byteLength), bytes])
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([head(2, value.byteLength), Buffer.from(value)])
  }
  if (Array.isArray(value)) {
    return Buffer.concat([head(4, value.length), ...value.map(cbor)])
  }
  if (value instanceof Map) {
    return Buffer.concat([
      head(5, value.size),
      ...[...value.entries()].flatMap(([k, v]) => [cbor(k), cbor(v)])
    ])
  }
  if (value === true) return Buffer.from([0xf5])
  if (value === false) return Buffer.from([0xf4])
  if (value === null) return Buffer.from([0xf6])
  throw new Error(`the fixture encoder cannot write ${typeof value}`)
}

/* ── attestation ─────────────────────────────────────────────────────────── */

const RP_ID = 'localhost'

/** The attested credential data an authenticator writes for a P-256 passkey. */
export function attestationFor(options: {
  credentialId?: Buffer
  rpId?: string
  flags?: number
  key?: { x: Buffer; y: Buffer }
  trailing?: Buffer
} = {}): { attestationObject: Buffer; credentialId: string; jwk: Record<string, unknown> } {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = keys.publicKey.export({ format: 'jwk' }) as Record<string, string>
  const x = options.key?.x ?? Buffer.from(jwk.x, 'base64url')
  const y = options.key?.y ?? Buffer.from(jwk.y, 'base64url')
  const credentialId = options.credentialId ?? Buffer.from('a-credential-id-32-bytes-long!!!', 'utf8')
  const cose = cbor(
    new Map<unknown, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(x)],
      [-3, new Uint8Array(y)]
    ])
  )
  const authData = Buffer.concat([
    createHash('sha256').update(options.rpId ?? RP_ID).digest(),
    Buffer.from([options.flags ?? 0x41]),
    Buffer.from([0, 0, 0, 1]),
    Buffer.alloc(16, 9),
    Buffer.from([credentialId.byteLength >> 8, credentialId.byteLength & 0xff]),
    credentialId,
    cose,
    options.trailing ?? Buffer.alloc(0)
  ])
  return {
    attestationObject: cbor(
      new Map<unknown, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)]
      ])
    ),
    credentialId: credentialId.toString('base64url'),
    jwk: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') }
  }
}


/** A platform authenticator: registers once, then signs assertions like a real one. */
export function platformAuthenticator(options: { rpId?: string; origin: string; credentialId?: Buffer }) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = keys.publicKey.export({ format: 'jwk' }) as Record<string, string>
  const rpId = options.rpId ?? 'localhost'
  const credentialId = options.credentialId ?? Buffer.from('platform-credential-id', 'utf8')
  const registration = attestationFor({
    rpId,
    credentialId,
    key: { x: Buffer.from(jwk.x, 'base64url'), y: Buffer.from(jwk.y, 'base64url') }
  })
  const assertionAuthData = Buffer.concat([
    createHash('sha256').update(rpId).digest(),
    Buffer.from([0x05]),
    Buffer.from([0, 0, 0, 9])
  ])
  return {
    credentialId: registration.credentialId,
    /** What `navigator.credentials.create` would post back. */
    create(challenge: string, tweak: { origin?: string; type?: string } = {}) {
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: tweak.type ?? 'webauthn.create',
          origin: tweak.origin ?? options.origin,
          challenge
        }),
        'utf8'
      )
      return {
        id: registration.credentialId,
        rawId: registration.credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          attestationObject: registration.attestationObject.toString('base64url')
        }
      }
    },
    /** What `navigator.credentials.get` would post back. */
    get(challenge: string, tweak: { origin?: string } = {}) {
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          origin: tweak.origin ?? options.origin,
          challenge
        }),
        'utf8'
      )
      const signature = sign(
        'sha256',
        Buffer.concat([assertionAuthData, createHash('sha256').update(clientDataJSON).digest()]),
        keys.privateKey
      )
      return {
        credential: {
          id: registration.credentialId,
          rawId: registration.credentialId,
          type: 'public-key',
          response: {
            clientDataJSON: clientDataJSON.toString('base64url'),
            authenticatorData: assertionAuthData.toString('base64url'),
            signature: signature.toString('base64url')
          }
        }
      }
    }
  }
}

export type PlatformAuthenticator = ReturnType<typeof platformAuthenticator>
export type { KeyObject }
