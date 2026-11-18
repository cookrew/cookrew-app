import { startHandshake, type SealAccept, type SealFinish, type SealSession } from '../canvas-seal'
import { fingerprintOfDigest, type KeyFingerprint } from '../key-fingerprint'
import { concat, fromB64u, hkdf, sameBytes, sha256, toB64u, u8, utf8, type Bytes } from './bytes'
import { createSeal2Session, type Seal2Session } from './records'
import { MODE_CODE, MODE_DEVICE, SEAL2_LABEL, SEAL2_VERSION } from './spec'

/**
 * COOKREW-SEAL/2 HANDSHAKES (spec.ts §1-2).
 *
 * CODE MODE: a phone or the console and its Mac, on the connect code the Mac
 * showed on its own screen. Same trust as v1: whoever holds the code is the
 * other end, and the carrier never sees it.
 *
 * DEVICE MODE: one desktop and another of the same account. WHAT IS TRUSTED:
 * each end proves its account device key by signing the transcript, and a
 * device id is a one-way function of that key, so the id a desktop dials is
 * the key it will accept and no carrier can answer in its place. What decides
 * WHICH ids are this account's desktops is cookrew.dev's account listing: an
 * operator of cookrew.dev who adds a desktop of their own to the account is
 * believed. Fingerprint words (pairWords) let the owner compare the two
 * screens once and pin the pair, after which a listing alone is not enough
 * (main/seal-peers.ts).
 */

const CODE_BYTES = 32
const KEY_BYTES = 32
const ID_BYTES = 16
const V1_ID_LABEL = 'cookrew-canvas-seal/1 id'
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_OFFERED = 8

export interface CodeHello {
  readonly v: 1
  readonly vs: readonly number[]
  readonly id: string
  readonly e: string
}

export interface DeviceKey {
  readonly kty: 'OKP'
  readonly crv: 'Ed25519'
  readonly x: string
}

export interface DeviceHello {
  readonly v: 2
  readonly vs: readonly number[]
  readonly mode: 'device'
  readonly from: string
  readonly to: string
  readonly jwk: DeviceKey
  readonly e: string
}

export interface Seal2Accept {
  readonly v: 2
  readonly e: string
  readonly proof: string
  readonly jwk?: DeviceKey
  readonly sig?: string
}

export interface Seal2Finish {
  readonly proof: string
  readonly sig?: string
}

/** This desktop's account device key, able to sign (main: account-v2.ts · signWithDevice). */
export interface DeviceSigner {
  readonly deviceId: string
  readonly jwk: DeviceKey
  sign(message: string): Promise<string>
}

/** Ed25519 verification of a base64url signature over a UTF-8 message. */
export type DeviceVerifier = (jwk: DeviceKey, message: string, sig: string) => Promise<boolean>

export interface HandshakeOptions {
  /** Fixed private key bytes, for the vectors. Everything else uses a fresh key. */
  readonly ephemeral?: Uint8Array
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The versions a hello offers, or null when its offer is malformed. */
export function offeredVersions(hello: unknown): number[] | null {
  if (!isRecord(hello) || !Array.isArray(hello.vs)) return null
  const vs = hello.vs as unknown[]
  const fine = vs.length >= 1 && vs.length <= MAX_OFFERED && vs.every((v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 255)
  return fine && new Set(vs).size === vs.length ? (vs as number[]) : null
}

/** True for a hello that asks for v2: the terminus answers it here, and any other through canvas-seal.ts. */
export const offersSeal2 = (hello: unknown): boolean => offeredVersions(hello)?.includes(SEAL2_VERSION) ?? false

export const isDeviceKey = (jwk: unknown): jwk is DeviceKey =>
  isRecord(jwk) && jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && typeof jwk.x === 'string' && fromB64u(jwk.x)?.length === 32

const thumbprintOf = (jwk: DeviceKey): Promise<Bytes> => sha256(utf8(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })))

/** The account device id of a key: the same uuid account-v2.ts · deviceIdFor gives. */
export async function deviceIdOf(jwk: DeviceKey): Promise<string> {
  const bytes = (await sha256(await thumbprintOf(jwk))).slice(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const uuidBytes = (id: string): Bytes => Uint8Array.from(id.replace(/-/g, '').match(/../g) ?? [], (pair) => parseInt(pair, 16)) as Bytes

/**
 * The words two desktops show for their pair: the same on both screens, and on
 * no other pair. Read once at first contact, they make the pairing the owner's
 * word and not only the account listing's.
 */
/**
 * The words ONE device is known by: six of them, from its id (and so its key). At first contact
 * each screen shows its own words and the other's, and the owner checks across: this computer's
 * own words on one screen must be the "other computer" words on the other. Faking that is finding
 * a key whose id gives one fixed set of words (2^66), where words over a pair could be matched by
 * someone choosing both sides of two pairs (a 2^33 collision; security review 2026-11-19).
 */
export async function deviceWords(id: string): Promise<KeyFingerprint> {
  if (!UUID.test(id)) throw new Error('Not a device id')
  return fingerprintOfDigest(await sha256(utf8(`${SEAL2_LABEL} device words`), u8(0), uuidBytes(id)))
}

export async function pairWords(a: string, b: string): Promise<KeyFingerprint> {
  if (!UUID.test(a) || !UUID.test(b)) throw new Error('Not a device id')
  const [low, high] = [a, b].sort()
  return fingerprintOfDigest(await sha256(utf8(`${SEAL2_LABEL} words`), u8(0), uuidBytes(low), uuidBytes(high)))
}

interface Ephemeral {
  readonly key: CryptoKey
  readonly raw: Bytes
  readonly secret: Bytes
}

async function ephemeralKey(fixed: Uint8Array | undefined): Promise<Ephemeral> {
  const secret = fixed === undefined ? crypto.getRandomValues(new Uint8Array(KEY_BYTES)) : concat(fixed)
  if (secret.length !== KEY_BYTES) throw new Error('An X25519 key is 32 bytes')
  const key = await crypto.subtle.importKey('pkcs8', concat(PKCS8_PREFIX, secret), { name: 'X25519' }, true, ['deriveBits'])
  const raw = fromB64u((await crypto.subtle.exportKey('jwk', key)).x)
  if (raw === null) throw new Error('This key has no public half')
  return { key, raw, secret }
}

/** Null for a key that is not one, and for a low-order key, which would make the secret zero. */
async function sharedSecret(mine: CryptoKey, theirs: Bytes | null): Promise<Bytes | null> {
  if (theirs === null || theirs.length !== KEY_BYTES) return null
  try {
    const key = await crypto.subtle.importKey('raw', theirs, { name: 'X25519' }, false, [])
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: key }, mine, KEY_BYTES * 8))
    return secret.some((byte) => byte !== 0) ? secret : null
  } catch {
    return null
  }
}

interface Schedule {
  readonly transcript: Bytes
  readonly sessionId: string
  readonly toResponder: Bytes
  readonly toInitiator: Bytes
  prove(who: 'responder' | 'initiator'): Promise<string>
  check(who: 'responder' | 'initiator', proof: unknown): Promise<boolean>
}

interface TranscriptInput {
  readonly mode: number
  readonly offered: readonly number[]
  readonly context: Uint8Array
  readonly initiator: Uint8Array
  readonly responder: Uint8Array
}

const transcriptOf = (input: TranscriptInput): Promise<Bytes> =>
  sha256(utf8(SEAL2_LABEL), u8(0), u8(input.mode), u8(SEAL2_VERSION), u8(input.offered.length), Uint8Array.from(input.offered), input.context, input.initiator, input.responder)

async function schedule(ikm: Uint8Array, input: TranscriptInput): Promise<Schedule> {
  const transcript = await transcriptOf(input)
  const keys = await hkdf(ikm, transcript, `${SEAL2_LABEL} keys`, KEY_BYTES * 3)
  const confirm = await crypto.subtle.importKey('raw', keys.slice(KEY_BYTES * 2), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  const message = (who: string): Bytes => concat(utf8(who), transcript)
  return {
    transcript,
    sessionId: toB64u(transcript.subarray(0, ID_BYTES)),
    toResponder: keys.slice(0, KEY_BYTES),
    toInitiator: keys.slice(KEY_BYTES, KEY_BYTES * 2),
    prove: async (who) => toB64u(new Uint8Array(await crypto.subtle.sign('HMAC', confirm, message(who)))),
    check: async (who, proof) => {
      const raw = fromB64u(proof)
      return raw !== null && raw.length === 32 && crypto.subtle.verify('HMAC', confirm, raw, message(who))
    }
  }
}

/** What a device signs: the transcript, in its own role's name. */
export const deviceSigned = (who: 'responder' | 'initiator', transcript: Uint8Array): string => `${SEAL2_LABEL} ${who}\n${toB64u(transcript)}`

const initiatorSession = (s: Schedule): Seal2Session => createSeal2Session(s.sessionId, s.toResponder, s.toInitiator, 'toResponder')
const responderSession = (s: Schedule): Seal2Session => createSeal2Session(s.sessionId, s.toInitiator, s.toResponder, 'toInitiator')

const checkedCode = (code: Uint8Array): Bytes => {
  if (code.length !== CODE_BYTES) throw new Error(`A connect code is ${CODE_BYTES} bytes`)
  return concat(code)
}

// ── code mode ─────────────────────────────────────────────────────────────

export type CodeFinished =
  | { readonly version: 2; readonly session: Seal2Session; readonly finish: Seal2Finish }
  | { readonly version: 1; readonly session: SealSession; readonly finish: SealFinish }

export interface StartedCodeHandshake {
  readonly hello: CodeHello
  /**
   * Null when the answer does not prove the code, or is v1 and v1 is not
   * allowed: nothing may be sent then. Once one has, every call gives that
   * same session: a second on these keys would reuse every nonce.
   */
  finish(accept: unknown): Promise<CodeFinished | null>
}

export interface CodeStartOptions extends HandshakeOptions {
  /** False once this code's Mac has spoken v2: a v1 answer then means a carrier stripped the offer. */
  readonly allowV1?: boolean
}

/** The phone's or console's side. */
export async function startCodeHandshake(code: Uint8Array, options: CodeStartOptions = {}): Promise<StartedCodeHandshake> {
  const secretCode = checkedCode(code)
  const id = await hkdf(secretCode, new Uint8Array(0), V1_ID_LABEL, ID_BYTES)
  const mine = await ephemeralKey(options.ephemeral)
  const offered = [SEAL2_VERSION]
  // The same key answers either version, so a Mac from before v2 reads this hello as its own.
  const v1 = options.allowV1 === false ? null : await startHandshake(secretCode, { ephemeral: mine.secret })
  let done: CodeFinished | null = null

  const finishV2 = async (accept: Record<string, unknown>): Promise<CodeFinished | null> => {
    const theirs = fromB64u(accept.e)
    const secret = await sharedSecret(mine.key, theirs)
    if (theirs === null || secret === null) return null
    const s = await schedule(concat(secret, secretCode), { mode: MODE_CODE, offered, context: id, initiator: mine.raw, responder: theirs })
    if (!(await s.check('responder', accept.proof))) return null
    const proof = await s.prove('initiator')
    // No await from here: two calls racing must not both make a session.
    done ??= { version: 2, session: initiatorSession(s), finish: { proof } }
    return done
  }

  return {
    hello: { v: 1, vs: offered, id: toB64u(id), e: toB64u(mine.raw) },
    async finish(accept) {
      if (done !== null) return done
      if (!isRecord(accept)) return null
      if (accept.v === SEAL2_VERSION) return finishV2(accept)
      if (accept.v !== undefined || v1 === null) return null
      const old = await v1.finish(accept as unknown as SealAccept)
      if (old === null) return null
      done ??= { version: 1, session: old.session, finish: old.finish }
      return done
    }
  }
}

export interface AcceptedSeal2 {
  readonly accept: Seal2Accept
  readonly session: Seal2Session
  /** The initiator proved itself. Until this says so, keep nothing for this session. */
  confirm(finish: unknown): Promise<boolean>
}

/** The Mac's side of a v2 code hello. Null for one it cannot read, or that does not offer v2. */
export async function acceptCodeHandshake(code: Uint8Array, hello: unknown, options: HandshakeOptions = {}): Promise<AcceptedSeal2 | null> {
  const secretCode = checkedCode(code)
  const offered = offeredVersions(hello)
  if (!isRecord(hello) || offered === null || !offered.includes(SEAL2_VERSION) || hello.v !== 1) return null
  const id = fromB64u(hello.id)
  const theirs = fromB64u(hello.e)
  const expected = await hkdf(secretCode, new Uint8Array(0), V1_ID_LABEL, ID_BYTES)
  if (id === null || !sameBytes(id, expected)) return null
  const mine = await ephemeralKey(options.ephemeral)
  const secret = await sharedSecret(mine.key, theirs)
  if (theirs === null || secret === null) return null
  const s = await schedule(concat(secret, secretCode), { mode: MODE_CODE, offered, context: id, initiator: theirs, responder: mine.raw })
  return {
    accept: { v: SEAL2_VERSION, e: toB64u(mine.raw), proof: await s.prove('responder') },
    session: responderSession(s),
    confirm: (finish) => s.check('initiator', isRecord(finish) ? finish.proof : null)
  }
}

// ── device mode ───────────────────────────────────────────────────────────

const deviceContext = async (from: string, to: string, initiator: DeviceKey, responder: DeviceKey): Promise<Bytes> =>
  concat(uuidBytes(from), uuidBytes(to), await thumbprintOf(initiator), await thumbprintOf(responder))

export interface StartedDeviceHandshake {
  readonly hello: DeviceHello
  /** Null unless the answer is signed by the very device dialled and proves the transcript. */
  finish(accept: unknown): Promise<{ readonly session: Seal2Session; readonly finish: Seal2Finish } | null>
}

export interface DeviceStartInput extends HandshakeOptions {
  readonly self: DeviceSigner
  /** The device id dialled: its key is the only one accepted. */
  readonly to: string
  readonly verify: DeviceVerifier
}

/** The dialling desktop's side. */
export async function startDeviceHandshake(input: DeviceStartInput): Promise<StartedDeviceHandshake> {
  const { self, to, verify } = input
  if (!UUID.test(to) || !UUID.test(self.deviceId) || !isDeviceKey(self.jwk)) throw new Error('Not a device')
  const mine = await ephemeralKey(input.ephemeral)
  const offered = [SEAL2_VERSION]
  let done: { readonly session: Seal2Session; readonly finish: Seal2Finish } | null = null
  return {
    hello: { v: SEAL2_VERSION, vs: offered, mode: 'device', from: self.deviceId, to, jwk: self.jwk, e: toB64u(mine.raw) },
    async finish(accept) {
      if (done !== null) return done
      if (!isRecord(accept) || accept.v !== SEAL2_VERSION || !isDeviceKey(accept.jwk) || typeof accept.sig !== 'string') return null
      const jwk: DeviceKey = { kty: 'OKP', crv: 'Ed25519', x: accept.jwk.x }
      if ((await deviceIdOf(jwk)) !== to) return null
      const theirs = fromB64u(accept.e)
      const secret = await sharedSecret(mine.key, theirs)
      if (theirs === null || secret === null) return null
      const context = await deviceContext(self.deviceId, to, self.jwk, jwk)
      const s = await schedule(secret, { mode: MODE_DEVICE, offered, context, initiator: mine.raw, responder: theirs })
      if (!(await s.check('responder', accept.proof))) return null
      if (!(await verify(jwk, deviceSigned('responder', s.transcript), accept.sig).catch(() => false))) return null
      const finish = { sig: await self.sign(deviceSigned('initiator', s.transcript)), proof: await s.prove('initiator') }
      done ??= { session: initiatorSession(s), finish }
      return done
    }
  }
}

export interface AcceptedDeviceSeal2 extends AcceptedSeal2 {
  /** Who dialled: the id is its key's own. Whether that id may come in is the caller's to decide. */
  readonly peer: { readonly deviceId: string; readonly jwk: DeviceKey }
}

export interface DeviceAcceptInput extends HandshakeOptions {
  readonly self: DeviceSigner
  readonly verify: DeviceVerifier
}

/** The dialled desktop's side. Null for a hello that is not to this device, or whose key is not its sender's. */
export async function acceptDeviceHandshake(hello: unknown, input: DeviceAcceptInput): Promise<AcceptedDeviceSeal2 | null> {
  const { self, verify } = input
  const offered = offeredVersions(hello)
  if (!isRecord(hello) || offered === null || !offered.includes(SEAL2_VERSION)) return null
  if (hello.v !== SEAL2_VERSION || hello.mode !== 'device' || hello.to !== self.deviceId) return null
  if (typeof hello.from !== 'string' || !UUID.test(hello.from) || !isDeviceKey(hello.jwk)) return null
  const jwk: DeviceKey = { kty: 'OKP', crv: 'Ed25519', x: hello.jwk.x }
  const from = hello.from
  if ((await deviceIdOf(jwk)) !== from || from === self.deviceId) return null
  const theirs = fromB64u(hello.e)
  const mine = await ephemeralKey(input.ephemeral)
  const secret = await sharedSecret(mine.key, theirs)
  if (theirs === null || secret === null) return null
  const context = await deviceContext(from, self.deviceId, jwk, self.jwk)
  const s = await schedule(secret, { mode: MODE_DEVICE, offered, context, initiator: theirs, responder: mine.raw })
  return {
    accept: { v: SEAL2_VERSION, e: toB64u(mine.raw), jwk: self.jwk, sig: await self.sign(deviceSigned('responder', s.transcript)), proof: await s.prove('responder') },
    session: responderSession(s),
    peer: { deviceId: from, jwk },
    async confirm(finish) {
      if (!isRecord(finish) || typeof finish.sig !== 'string') return false
      if (!(await s.check('initiator', finish.proof))) return false
      return verify(jwk, deviceSigned('initiator', s.transcript), finish.sig).catch(() => false)
    }
  }
}
