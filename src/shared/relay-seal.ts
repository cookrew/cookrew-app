import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  timingSafeEqual
} from 'node:crypto'

/**
 * THE SEAL — end-to-end between a caller and a door, over a relay that carries
 * bytes it cannot read.
 *
 * WHY IT EXISTS. A relay terminates TLS on both hops, so HTTPS alone protects
 * the conversation from the network and not from the relay. The product
 * promises "Cookrew never sends your conversation anywhere else"; that
 * sentence is only true if the machine in the middle is unable to read what it
 * carries. Both ends are Cookrew, so we can simply make it unable.
 *
 * WHY IT DOES NOT COST THROUGHPUT. The terminal is a stream of small bursts,
 * and what kills such a stream is not cipher speed, it is round trips and
 * waiting:
 *
 *   ONE handshake per connection, not per request. Everything after it is a
 *   local operation on both sides.
 *   NO per-frame nonce on the wire. The nonce is the frame's own sequence
 *   number, which both ends already agree on, so a sealed frame costs the
 *   16-byte tag and nothing else.
 *   NO batching, NO padding. A chunk is sealed and sent the moment it exists;
 *   delaying it to make the stream tidier is the one thing that would be felt.
 *
 * The sequence number is also the ordering guarantee: a frame replayed or
 * delivered out of order fails to open, because its nonce is wrong. That falls
 * out of the counter rather than being a second mechanism.
 *
 * WHAT IT PROVES, precisely. The caller learns it is talking to the holder of
 * the door's published key — the relay cannot stand in the middle, because it
 * cannot compute the shared secret. It does NOT authenticate the caller: that
 * is the door's own ed25519 sign-in, one layer up, and duplicating it here
 * would be a second identity that could disagree with the first.
 *
 * FORWARD SECRECY is real: both sides contribute an ephemeral key, so a door's
 * long-term key stolen tomorrow does not open what was said today.
 */

/** X25519 raw public key, base64url. Short enough to ride in a door record. */
export type SealPublicKey = string

export interface SealKeyPair {
  publicKey: SealPublicKey
  /** PKCS8, base64url. Never leaves the process that made it. */
  privateKey: string
}

const B64 = 'base64url' as const
const KEY_BYTES = 32
const TAG_BYTES = 16
const NONCE_BYTES = 12

/** A door's long-term identity for the seal. Published; safe to hand out. */
export function generateSealKeyPair(): SealKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString(B64),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString(B64)
  }
}

function publicOf(key: SealPublicKey): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key: Buffer.from(key, B64), type: 'spki', format: 'der' })
}

function privateOf(key: string): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({ key: Buffer.from(key, B64), type: 'pkcs8', format: 'der' })
}

/**
 * Two directions, two keys.
 *
 * One key in both directions would let a frame the door sent be replayed back
 * at it as though the caller had said it — the sequence numbers are per
 * direction, so the nonces would collide.
 */
export interface SealedChannel {
  seal(plaintext: string): string
  open(sealed: string, seq: number): string | null
  /** The next sequence number this side will use. Exposed for the framing. */
  next(): number
}

function channel(key: Buffer): SealedChannel {
  let seq = 0
  return {
    next: () => seq,
    seal(plaintext) {
      const nonce = nonceOf(seq++)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.concat([body, cipher.getAuthTag()]).toString(B64)
    },
    open(sealed, at) {
      try {
        const raw = Buffer.from(sealed, B64)
        if (raw.length < TAG_BYTES) return null
        const body = raw.subarray(0, raw.length - TAG_BYTES)
        const tag = raw.subarray(raw.length - TAG_BYTES)
        const decipher = createDecipheriv('aes-256-gcm', key, nonceOf(at))
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
      } catch {
        // A tag that does not verify is not an error to report in detail — it
        // is a frame that was tampered with, replayed, or reordered, and all
        // three get the same silence.
        return null
      }
    }
  }
}

/** The nonce IS the sequence number. No randomness, nothing on the wire. */
function nonceOf(seq: number): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES)
  nonce.writeUInt32BE(Math.floor(seq / 0x100000000), 0)
  nonce.writeUInt32BE(seq >>> 0, 4)
  return nonce
}

export interface SealedPair {
  /** What this side sends. */
  tx: SealedChannel
  /** What this side receives. */
  rx: SealedChannel
}

/**
 * Derive both directions from the shared secrets.
 *
 * `info` binds the keys to the door's name, so a secret negotiated for one
 * door cannot be replayed at another even if the same ephemeral were reused.
 */
function derive(secrets: Buffer, info: string, initiator: boolean): SealedPair {
  const material = Buffer.from(
    hkdfSync('sha256', secrets, Buffer.alloc(0), Buffer.from(`cookrew-relay/1 ${info}`), KEY_BYTES * 2)
  )
  const first = material.subarray(0, KEY_BYTES)
  const second = material.subarray(KEY_BYTES)
  // The initiator sends on the first key and listens on the second; the
  // responder does the opposite. Two keys, one derivation, no negotiation.
  return initiator
    ? { tx: channel(first), rx: channel(second) }
    : { tx: channel(second), rx: channel(first) }
}

/** What the caller sends to begin. Public values only. */
export interface SealHello {
  /** The caller's ephemeral public key. */
  e: SealPublicKey
}

/** What the door answers with. Public values only. */
export interface SealAccept {
  /** The door's ephemeral public key. */
  e: SealPublicKey
}

/**
 * CALLER SIDE, step one: make an ephemeral and say hello.
 *
 * `doorKey` is the door's published long-term key, pinned by the caller on
 * first import (TOFU, the same rule the sign-in already uses). A relay that
 * substituted its own key would produce a channel the real door cannot read,
 * so the substitution fails loudly at the first frame rather than silently
 * succeeding as a man in the middle.
 */
export function startSeal(
  doorKey: SealPublicKey,
  info: string
): { hello: SealHello; finish: (accept: SealAccept) => SealedPair } {
  const ephemeral = generateSealKeyPair()
  const priv = privateOf(ephemeral.privateKey)
  // To the door's LONG-TERM key: this is what proves the door is the door.
  const toStatic = diffieHellman({ privateKey: priv, publicKey: publicOf(doorKey) })
  return {
    hello: { e: ephemeral.publicKey },
    finish: (accept) => {
      // To the door's EPHEMERAL key: this is what makes today's words safe
      // from tomorrow's theft of the long-term key.
      const toEphemeral = diffieHellman({ privateKey: priv, publicKey: publicOf(accept.e) })
      return derive(Buffer.concat([toStatic, toEphemeral]), info, true)
    }
  }
}

/**
 * DOOR SIDE: answer a hello. Returns what to send back and the live channel.
 */
export function acceptSeal(
  doorPrivateKey: string,
  hello: SealHello,
  info: string
): { accept: SealAccept; channel: SealedPair } {
  const ephemeral = generateSealKeyPair()
  const callerEphemeral = publicOf(hello.e)
  const toStatic = diffieHellman({
    privateKey: privateOf(doorPrivateKey),
    publicKey: callerEphemeral
  })
  const toEphemeral = diffieHellman({
    privateKey: privateOf(ephemeral.privateKey),
    publicKey: callerEphemeral
  })
  return {
    accept: { e: ephemeral.publicKey },
    channel: derive(Buffer.concat([toStatic, toEphemeral]), info, false)
  }
}

/**
 * A REQUEST BODY, sealed with no round trip.
 *
 * The handshake above rides open→head and costs nothing extra for a GET,
 * because a GET has nothing to send first. A POST does: its body would have to
 * wait for the door's ephemeral to arrive, and that wait is a round trip added
 * to every prompt someone submits. So a body is sealed to the door's LONG-TERM
 * key instead, which needs nothing from the door.
 *
 * THE HONEST COST, stated where it is paid: this half is NOT forward secret.
 * Someone who steals a door's long-term key later, and who also recorded the
 * traffic, can read the prompts — not the replies, which use the ephemeral
 * channel. The upgrade is a rotating pre-key published in the door record;
 * until then the asymmetry is real and is the price of not making every ask
 * wait for a round trip.
 */
export function sealToDoor(
  doorKey: SealPublicKey,
  info: string,
  plaintext: string
): { e: SealPublicKey; sealed: string } {
  const ephemeral = generateSealKeyPair()
  const shared = diffieHellman({
    privateKey: privateOf(ephemeral.privateKey),
    publicKey: publicOf(doorKey)
  })
  return {
    e: ephemeral.publicKey,
    // Sequence 0 and thrown away: this key seals exactly one message, so a
    // counter would have nothing to count.
    sealed: channel(bodyKey(shared, info)).seal(plaintext)
  }
}

/** Open a body sealed to this door. Null on anything that does not verify. */
export function openFromCaller(
  doorPrivateKey: string,
  info: string,
  e: SealPublicKey,
  sealed: string
): string | null {
  try {
    const shared = diffieHellman({
      privateKey: privateOf(doorPrivateKey),
      publicKey: publicOf(e)
    })
    return channel(bodyKey(shared, info)).open(sealed, 0)
  } catch {
    return null
  }
}

/** Separate label from the channel keys: one secret must never do two jobs. */
function bodyKey(shared: Buffer, info: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(`cookrew-relay/1 body ${info}`), KEY_BYTES)
  )
}

/**
 * THE REQUEST ENVELOPE — the wire names, in one place, for both sides.
 *
 * WHAT THE RELAY STILL SEES, said plainly so nobody has to infer it: the shape
 * of an exchange. Method, path, status, byte sizes and timing. It does NOT see
 * headers — which carry the caller's Bearer and the payment header — nor
 * request bodies, nor a single byte of the reply.
 *
 * The path stays readable on purpose: the relay refuses anything that is not a
 * door path, and giving up that containment to hide a route name from our own
 * hub would be a bad trade. A route name is not a conversation.
 */
export const SEAL_EPHEMERAL = 'x-seal-e'
export const SEAL_KEY = 'x-seal-k'
export const SEAL_HEADERS = 'x-seal-h'

/**
 * Seal a request's headers to the door, and carry the handshake's ephemeral.
 *
 * Two public values, doing two different jobs: `SEAL_EPHEMERAL` starts the
 * forward-secret channel the REPLY will use, and `SEAL_KEY` is a throwaway that
 * seals these headers right now — because there is nothing to wait for and
 * waiting is what would be felt.
 */
export function packRequest(
  doorKey: SealPublicKey,
  info: string,
  ephemeral: SealPublicKey,
  headers: Record<string, string>
): Record<string, string> {
  const sealed = sealToDoor(doorKey, info, JSON.stringify(headers))
  return {
    [SEAL_EPHEMERAL]: ephemeral,
    [SEAL_KEY]: sealed.e,
    [SEAL_HEADERS]: sealed.sealed
  }
}

/** Door side: the caller's real headers, and the hello to answer. */
export function openRequest(
  doorPrivateKey: string,
  info: string,
  wire: Record<string, string>
): { headers: Record<string, string>; hello: SealHello } | null {
  const e = wire[SEAL_EPHEMERAL]
  const key = wire[SEAL_KEY]
  const sealed = wire[SEAL_HEADERS]
  if (!e || !key || !sealed) return null
  const headers = asHeaders(openFromCaller(doorPrivateKey, info, key, sealed))
  return headers === null ? null : { headers, hello: { e } }
}

/** A request body, sealed to the door. Same no-round-trip bargain as above. */
export function packBody(doorKey: SealPublicKey, info: string, body: string): string {
  const sealed = sealToDoor(doorKey, info, body)
  return `${sealed.e}.${sealed.sealed}`
}

export function openBody(doorPrivateKey: string, info: string, wire: string): string | null {
  const dot = wire.indexOf('.')
  if (dot < 1) return null
  return openFromCaller(doorPrivateKey, info, wire.slice(0, dot), wire.slice(dot + 1))
}

function asHeaders(value: string | null): Record<string, string> | null {
  if (value === null) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val !== 'string') return null
      out[key.toLowerCase()] = val
    }
    return out
  } catch {
    return null
  }
}

/** Do two channels hold the same key? For tests and for a health probe. */
export function sameSecret(a: SealedPair, b: SealedPair): boolean {
  const probe = a.tx.seal('probe')
  const opened = b.rx.open(probe, 0)
  return opened !== null && timingSafeEqual(Buffer.from(opened), Buffer.from('probe'))
}
