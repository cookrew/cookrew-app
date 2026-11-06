/**
 * THE CANVAS SEAL: one session between a phone and its Mac that the relay can
 * carry and cannot read.
 *
 * WebCrypto only, so the Mac and the page run this same file and no second copy
 * of the cipher can drift. tests/fixtures/canvas-seal-vectors.json is written by
 * a separate node:crypto implementation (scripts/canvas-seal-vectors.mjs), and a
 * native client checks itself against the same file.
 *
 * THE CONNECT CODE is 32 random bytes the Mac made, carried to a phone in a QR
 * link's fragment, so it never crosses the relay. It goes into the key derivation:
 * a relay in the middle can run the key exchange but cannot derive the keys, on the
 * very first connection, with no key to pin or words to compare. Only `id`, a
 * one-way derivation of the code, travels, so the Mac can look the code up.
 *
 * THE HANDSHAKE, with `|` as concatenation:
 *
 *   id          HKDF(code, salt "", "<label> id", 16)
 *   phone->Mac  hello  { v, id, e_i }
 *   Mac->phone  accept { e_r, proof("responder") }
 *   phone->Mac  finish { proof("initiator") }
 *
 *   transcript  SHA-256(label | id | e_i | e_r)
 *   keys        HKDF(X25519(e_i, e_r) | code, salt transcript, "<label> keys", 96)
 *               = to-responder key | to-initiator key | confirm key
 *   proof(who)  HMAC-SHA-256(confirm key, who | transcript)
 *
 * Fresh ephemerals on both sides give forward secrecy: a code stolen tomorrow does
 * not open today's traffic. It does let the thief impersonate either side.
 *
 * RECORDS are AES-256-GCM, one key per direction, the nonce being the record's
 * sequence number. On the wire: u32 length | u64 sequence | ciphertext and tag
 * (canvas-seal-wire.ts, with the inbox and the frames).
 *
 * WHAT THIS DOES NOT DO. It protects bytes in transit from whoever carries them.
 * It cannot protect a page from whoever served that page: see shared/remote-unlock.ts.
 * The relay still sees timing and sizes, and a record's sequence number.
 */

export const SEAL_LABEL = 'cookrew-canvas-seal/1'
export const SEAL_CODE_BYTES = 32
/** The most one record carries. */
export const SEAL_RECORD_MAX = 256 * 1024

const KEY_BYTES = 32
const ID_BYTES = 16
const TAG_BYTES = 16
const NONCE_BYTES = 12
/** A session is replaced long before this. Past it a nonce could repeat. */
export const SEQ_LIMIT = 2 ** 48
/** A bare X25519 private key as PKCS8: the prefix, then the 32 bytes. */
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20])

type Bytes = Uint8Array<ArrayBuffer>

export interface SealHello {
  readonly v: 1
  readonly id: string
  readonly e: string
}

export interface SealAccept {
  readonly e: string
  readonly proof: string
}

export interface SealFinish {
  readonly proof: string
}

export interface SealRecord {
  readonly seq: number
  readonly box: Uint8Array
}

export interface SealSession {
  /** The same on both sides, and on no other session. */
  readonly id: string
  seal(plain: Uint8Array): Promise<SealRecord>
  /** Null on anything that does not verify: tampered, replayed under another number, or foreign. */
  open(record: SealRecord): Promise<Uint8Array | null>
}

/** Fixed private key bytes, for the vectors. Everything else uses a fresh key. */
export interface SealOptions {
  readonly ephemeral?: Uint8Array
}

const encoder = new TextEncoder()

export const concat = (...parts: readonly Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  parts.reduce((at, part) => {
    out.set(part, at)
    return at + part.length
  }, 0)
  return out
}

const toBase64Url = (data: Uint8Array): string => btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const fromBase64Url = (text: unknown): Bytes | null => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) return null
  try {
    const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
    // One spelling per value: spare trailing bits would make two strings of one key.
    return toBase64Url(bytes) === text ? bytes : null
  } catch {
    return null
  }
}

const hkdf = async (ikm: Bytes, salt: Bytes, info: string, length: number): Promise<Bytes> => {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) }, key, length * 8))
}

const checkedCode = (code: Uint8Array): Bytes => {
  if (code.length !== SEAL_CODE_BYTES) throw new Error(`A connect code is ${SEAL_CODE_BYTES} bytes`)
  return concat(code)
}

export const newConnectCode = (): Bytes => crypto.getRandomValues(new Uint8Array(SEAL_CODE_BYTES))

const idBytes = (code: Bytes): Promise<Bytes> => hkdf(code, new Uint8Array(0), `${SEAL_LABEL} id`, ID_BYTES)

export const connectCodeId = async (code: Uint8Array): Promise<string> => toBase64Url(await idBytes(checkedCode(code)))

interface Ephemeral {
  readonly key: CryptoKey
  readonly raw: Bytes
}

async function ephemeralKey(fixed: Uint8Array | undefined): Promise<Ephemeral> {
  if (fixed === undefined) {
    const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
    return { key: pair.privateKey, raw: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) }
  }
  const key = await crypto.subtle.importKey('pkcs8', concat(PKCS8_PREFIX, fixed), { name: 'X25519' }, true, ['deriveBits'])
  const jwk = await crypto.subtle.exportKey('jwk', key)
  const raw = fromBase64Url(jwk.x)
  if (raw === null) throw new Error('This key has no public half')
  return { key, raw }
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

const nonceOf = (seq: number): Bytes => {
  const nonce = new Uint8Array(NONCE_BYTES)
  const view = new DataView(nonce.buffer)
  view.setUint32(0, Math.floor(seq / 0x100000000))
  view.setUint32(4, seq % 0x100000000)
  return nonce
}

function createSession(id: string, sendKey: CryptoKey, openKey: CryptoKey): SealSession {
  let next = 0
  return {
    id,
    async seal(plain) {
      if (plain.length > SEAL_RECORD_MAX) throw new Error('This record is too large')
      if (next >= SEQ_LIMIT) throw new Error('This session is used up')
      // Taken before the first await: the order asked is the order numbered.
      const seq = next
      next += 1
      const box = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceOf(seq), tagLength: TAG_BYTES * 8 }, sendKey, plain as BufferSource)
      return { seq, box: new Uint8Array(box) }
    },
    async open({ seq, box }) {
      if (!Number.isSafeInteger(seq) || seq < 0 || seq >= SEQ_LIMIT) return null
      try {
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonceOf(seq), tagLength: TAG_BYTES * 8 }, openKey, box as BufferSource))
      } catch {
        return null
      }
    }
  }
}

interface Derived {
  readonly sessionId: string
  readonly toResponder: CryptoKey
  readonly toInitiator: CryptoKey
  prove(who: string): Promise<string>
  check(who: string, proof: unknown): Promise<boolean>
}

async function derive(code: Bytes, id: Bytes, initiator: Bytes, responder: Bytes, secret: Bytes): Promise<Derived> {
  const transcript = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(encoder.encode(SEAL_LABEL), id, initiator, responder)))
  const keys = await hkdf(concat(secret, code), transcript, `${SEAL_LABEL} keys`, KEY_BYTES * 3)
  const aes = (from: number): Promise<CryptoKey> => crypto.subtle.importKey('raw', keys.subarray(from, from + KEY_BYTES), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const confirm = await crypto.subtle.importKey('raw', keys.subarray(KEY_BYTES * 2), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  const message = (who: string): Bytes => concat(encoder.encode(who), transcript)
  return {
    sessionId: toBase64Url(transcript.subarray(0, ID_BYTES)),
    toResponder: await aes(0),
    toInitiator: await aes(KEY_BYTES),
    prove: async (who) => toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', confirm, message(who)))),
    check: async (who, proof) => {
      const raw = fromBase64Url(proof)
      return raw !== null && crypto.subtle.verify('HMAC', confirm, raw, message(who))
    }
  }
}

export interface StartedHandshake {
  readonly hello: SealHello
  /**
   * Null when the answer does not prove the code: nothing may be sent then. Once
   * one has, every call gives that same session: a second session on these keys
   * would count from zero again and reuse every nonce.
   */
  finish(accept: SealAccept): Promise<{ readonly session: SealSession; readonly finish: SealFinish } | null>
}

/** The phone's side. */
export async function startHandshake(code: Uint8Array, options: SealOptions = {}): Promise<StartedHandshake> {
  const secretCode = checkedCode(code)
  const id = await idBytes(secretCode)
  const mine = await ephemeralKey(options.ephemeral)
  let done: { readonly session: SealSession; readonly finish: SealFinish } | null = null
  return {
    hello: { v: 1, id: toBase64Url(id), e: toBase64Url(mine.raw) },
    async finish(accept) {
      if (done !== null) return done
      const theirs = fromBase64Url(accept?.e)
      const secret = await sharedSecret(mine.key, theirs)
      if (theirs === null || secret === null) return null
      const derived = await derive(secretCode, id, mine.raw, theirs, secret)
      if (!(await derived.check('responder', accept.proof))) return null
      const proof = await derived.prove('initiator')
      // No await from here: two calls racing must not both make a session.
      done ??= { session: createSession(derived.sessionId, derived.toResponder, derived.toInitiator), finish: { proof } }
      return done
    }
  }
}

export interface AcceptedHandshake {
  readonly accept: SealAccept
  readonly session: SealSession
  /** The phone proved the code. Until this says so, keep nothing for this session. */
  confirm(finish: SealFinish): Promise<boolean>
}

/** The Mac's side, with the code `hello.id` named. Null for a hello it cannot read. */
export async function acceptHandshake(code: Uint8Array, hello: SealHello, options: SealOptions = {}): Promise<AcceptedHandshake | null> {
  const secretCode = checkedCode(code)
  const id = fromBase64Url(hello?.id)
  const theirs = fromBase64Url(hello?.e)
  if (hello?.v !== 1 || id === null || id.length !== ID_BYTES || theirs === null) return null
  const mine = await ephemeralKey(options.ephemeral)
  const secret = await sharedSecret(mine.key, theirs)
  if (secret === null) return null
  const derived = await derive(secretCode, id, theirs, mine.raw, secret)
  return {
    accept: { e: toBase64Url(mine.raw), proof: await derived.prove('responder') },
    session: createSession(derived.sessionId, derived.toInitiator, derived.toResponder),
    confirm: (finish) => derived.check('initiator', finish?.proof)
  }
}
