import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'

/**
 * A BROWSER'S HALF OF WEBAUTHN, in about a hundred lines.
 *
 * The registry's passkey code is proved against bytes that were BUILT rather
 * than captured: a COSE key encoded into authenticator data, wrapped in an
 * attestation object, and signed by a key pair node:crypto minted here. A
 * capture proves one browser once worked; building the bytes proves we read
 * the format, and signing with a real key proves the verification is
 * verification and not a shape check.
 *
 * Shared by the unit tests and the HTTP tests so there is one idea of what a
 * credential looks like — two would drift, and the drift would land in
 * whichever suite was read second.
 */

export const b64u = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('base64url')
const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8')

/* ── a very small CBOR encoder, for fixtures only ─────────────────────────── */

const head = (major: number, argument: number): Buffer => {
  if (argument < 24) return Buffer.from([(major << 5) | argument])
  if (argument < 256) return Buffer.from([(major << 5) | 24, argument])
  if (argument < 65536) return Buffer.from([(major << 5) | 25, argument >> 8, argument & 255])
  const out = Buffer.alloc(5)
  out[0] = (major << 5) | 26
  out.writeUInt32BE(argument, 1)
  return out
}
export const cborInt = (value: number): Buffer => (value >= 0 ? head(0, value) : head(1, -1 - value))
export const cborBytes = (bytes: Uint8Array | Buffer): Buffer =>
  Buffer.concat([head(2, bytes.length), Buffer.from(bytes)])
export const cborText = (value: string): Buffer => Buffer.concat([head(3, utf8(value).length), utf8(value)])
export const cborMap = (entries: readonly [number | string, Buffer][]): Buffer =>
  Buffer.concat([
    head(5, entries.length),
    ...entries.map(([key, value]) => Buffer.concat([typeof key === 'number' ? cborInt(key) : cborText(key), value]))
  ])

/* ── an authenticator ─────────────────────────────────────────────────────── */

export const rpIdHash = (rpId: string): Buffer => createHash('sha256').update(rpId, 'utf8').digest()

export interface Pair {
  alg: number
  cose: Buffer
  privateKey: KeyObject
  publicJwk: Record<string, string>
}

export function p256(): Pair {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>
  return {
    alg: -7,
    privateKey: pair.privateKey,
    publicJwk: jwk,
    cose: cborMap([
      [1, cborInt(2)],
      [3, cborInt(-7)],
      [-1, cborInt(1)],
      [-2, cborBytes(Buffer.from(jwk.x, 'base64url'))],
      [-3, cborBytes(Buffer.from(jwk.y, 'base64url'))]
    ])
  }
}

export function ed25519(): Pair {
  const pair = generateKeyPairSync('ed25519')
  const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>
  return {
    alg: -8,
    privateKey: pair.privateKey,
    publicJwk: jwk,
    cose: cborMap([
      [1, cborInt(1)],
      [3, cborInt(-8)],
      [-1, cborInt(6)],
      [-2, cborBytes(Buffer.from(jwk.x, 'base64url'))]
    ])
  }
}

const AAGUID = Buffer.alloc(16, 7)

/** rpIdHash ‖ flags ‖ signCount [ ‖ aaguid ‖ len ‖ credentialId ‖ COSE ]. */
export function authData(input: {
  rpId: string
  flags: number
  signCount: number
  credentialId?: Buffer
  cose?: Buffer
}): Buffer {
  const counter = Buffer.alloc(4)
  counter.writeUInt32BE(input.signCount)
  const start = Buffer.concat([rpIdHash(input.rpId), Buffer.from([input.flags]), counter])
  if (input.credentialId === undefined || input.cose === undefined) return start
  const length = Buffer.alloc(2)
  length.writeUInt16BE(input.credentialId.length)
  return Buffer.concat([start, AAGUID, length, input.credentialId, input.cose])
}

export const attestationObject = (data: Buffer, fmt = 'none'): string =>
  b64u(
    cborMap([
      ['fmt', cborText(fmt)],
      ['attStmt', cborMap([])],
      ['authData', cborBytes(data)]
    ])
  )

export const clientData = (input: { type: string; challenge: string; origin: string }): string =>
  b64u(utf8(JSON.stringify({ type: input.type, challenge: input.challenge, origin: input.origin })))

/** UP + AT: a person was there, and a credential is attached. */
export const CREATE_FLAGS = 0x41
/** UP: a person was there. */
export const GET_FLAGS = 0x01

/** What `navigator.credentials.create` would hand back. */
export function makeCredential(input: {
  pair: Pair
  credentialId: Buffer
  challenge: string
  origin: string
  rpId: string
  signCount?: number
}): { id: string; rawId: string; response: { clientDataJSON: string; attestationObject: string } } {
  const data = authData({
    rpId: input.rpId,
    flags: CREATE_FLAGS,
    signCount: input.signCount ?? 0,
    credentialId: input.credentialId,
    cose: input.pair.cose
  })
  return {
    id: b64u(input.credentialId),
    rawId: b64u(input.credentialId),
    response: {
      clientDataJSON: clientData({ type: 'webauthn.create', challenge: input.challenge, origin: input.origin }),
      attestationObject: attestationObject(data)
    }
  }
}

/** What `navigator.credentials.get` would hand back, signed for real. */
export function getAssertion(input: {
  pair: Pair
  credentialId: Buffer
  challenge: string
  origin: string
  rpId: string
  signCount?: number
  userHandle?: string
}): {
  id: string
  rawId: string
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string }
} {
  const data = authData({ rpId: input.rpId, flags: GET_FLAGS, signCount: input.signCount ?? 0 })
  const clientDataJSON = clientData({ type: 'webauthn.get', challenge: input.challenge, origin: input.origin })
  const signed = Buffer.concat([data, createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest()])
  const signature = input.pair.alg === -8 ? sign(null, signed, input.pair.privateKey) : sign('sha256', signed, input.pair.privateKey)
  return {
    id: b64u(input.credentialId),
    rawId: b64u(input.credentialId),
    response: {
      clientDataJSON,
      authenticatorData: b64u(data),
      signature: b64u(signature),
      ...(input.userHandle === undefined ? {} : { userHandle: input.userHandle })
    }
  }
}
