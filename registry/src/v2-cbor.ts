/**
 * IDENTITY v2 — A CBOR DECODER WITH WALLS.
 *
 * WebAuthn's attestation object is CBOR, so a browser hands this registry a
 * stranger's bytes and asks it to make a structure out of them. That is the
 * whole reason this file is written rather than installed: a general decoder
 * reads everything CBOR can express — indefinite-length streams, tags,
 * bignums, four-gigabyte strings — and every one of those is a shape our one
 * input never has and an unauthenticated allocation we would have agreed to.
 *
 * So this reads the SUBSET an attestation is made of and refuses the rest with
 * a reason:
 *   · unsigned and negative integers inside the exact-integer range
 *   · byte strings and utf-8 text, bounded by what is actually in the buffer
 *   · arrays and maps, bounded in count and in nesting
 *   · false, true, null
 * Anything else — a tag, a float, an indefinite length, a duplicate map key —
 * is a refusal. A partial value is never returned: there is no half-read
 * attestation that is safe to act on.
 */

export type CborValue = number | string | boolean | null | Uint8Array | CborValue[] | CborMap
export type CborMap = Map<number | string, CborValue>

export type CborRefusal =
  | 'truncated'
  | 'indefinite'
  | 'tag'
  | 'too_deep'
  | 'too_many'
  | 'too_large'
  | 'duplicate_key'
  | 'bad_key'
  | 'bad_text'
  | 'unsupported_simple'
  | 'trailing'

export type CborResult =
  | { ok: true; value: CborValue; end: number }
  | { ok: false; reason: CborRefusal }

/** An attestation nests three deep; this is generous and still shallow. */
export const CBOR_MAX_DEPTH = 32
/** No structure we read has thousands of members, and a header can claim millions. */
export const CBOR_MAX_ITEMS = 4096

const text = new TextDecoder('utf-8', { fatal: true })

class Refusal extends Error {
  readonly reason: CborRefusal
  constructor(reason: CborRefusal) {
    super(reason)
    this.reason = reason
  }
}

class Reader {
  private readonly bytes: Uint8Array
  private at = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  get end(): number {
    return this.at
  }

  private byte(): number {
    if (this.at >= this.bytes.length) throw new Refusal('truncated')
    return this.bytes[this.at++]
  }

  private take(length: number): Uint8Array {
    // Checked against what is HERE before anything is allocated: a header
    // claiming four gigabytes must cost nothing to refuse.
    if (length > this.bytes.length - this.at) throw new Refusal('truncated')
    const out = this.bytes.slice(this.at, this.at + length)
    this.at += length
    return out
  }

  /** The argument of a head byte, refusing indefinite lengths and huge counts. */
  private argument(info: number): number {
    if (info < 24) return info
    if (info === 24) return this.byte()
    if (info === 25) return (this.byte() << 8) | this.byte()
    if (info === 26) {
      const value = this.byte() * 0x1000000 + (this.byte() << 16) + (this.byte() << 8) + this.byte()
      return value
    }
    if (info === 27) {
      const high = this.take(4)
      const low = this.take(4)
      const value =
        (high[0] * 0x1000000 + (high[1] << 16) + (high[2] << 8) + high[3]) * 0x100000000 +
        (low[0] * 0x1000000 + (low[1] << 16) + (low[2] << 8) + low[3])
      if (!Number.isSafeInteger(value)) throw new Refusal('too_large')
      return value
    }
    // 28–30 are reserved; 31 is "indefinite", which has no length to bound.
    throw new Refusal(info === 31 ? 'indefinite' : 'too_large')
  }

  item(depth: number): CborValue {
    if (depth > CBOR_MAX_DEPTH) throw new Refusal('too_deep')
    const head = this.byte()
    const major = head >> 5
    const info = head & 31
    if (major === 0) return this.argument(info)
    if (major === 1) {
      const argument = this.argument(info)
      if (!Number.isSafeInteger(-1 - argument)) throw new Refusal('too_large')
      return -1 - argument
    }
    if (major === 2) return this.take(this.argument(info))
    if (major === 3) {
      const raw = this.take(this.argument(info))
      try {
        return text.decode(raw)
      } catch {
        throw new Refusal('bad_text')
      }
    }
    if (major === 4) {
      const count = this.count(info)
      const out: CborValue[] = []
      for (let i = 0; i < count; i++) out.push(this.item(depth + 1))
      return out
    }
    if (major === 5) {
      const count = this.count(info)
      const out: CborMap = new Map()
      for (let i = 0; i < count; i++) {
        const key = this.item(depth + 1)
        if (typeof key !== 'number' && typeof key !== 'string') throw new Refusal('bad_key')
        // Two values under one key is a document with two meanings; picking
        // either is a decision this decoder has no standing to make.
        if (out.has(key)) throw new Refusal('duplicate_key')
        out.set(key, this.item(depth + 1))
      }
      return out
    }
    if (major === 6) throw new Refusal('tag')
    // Major 7: only the three simple values. A float, `undefined` and every
    // unassigned simple value are refused rather than mapped onto something.
    if (info === 20) return false
    if (info === 21) return true
    if (info === 22) return null
    throw new Refusal('unsupported_simple')
  }

  private count(info: number): number {
    const count = this.argument(info)
    if (count > CBOR_MAX_ITEMS) throw new Refusal('too_many')
    return count
  }
}

/** One item, and where it ended — for authData, whose COSE key is followed by more. */
export function decodeCborItem(bytes: Uint8Array): CborResult {
  const reader = new Reader(bytes)
  try {
    const value = reader.item(0)
    return { ok: true, value, end: reader.end }
  } catch (error) {
    return { ok: false, reason: error instanceof Refusal ? error.reason : 'truncated' }
  }
}

/** One item and NOTHING after it — an attestation object is exactly one value. */
export function decodeCbor(bytes: Uint8Array): CborResult {
  const out = decodeCborItem(bytes)
  if (!out.ok) return out
  return out.end === bytes.length ? out : { ok: false, reason: 'trailing' }
}

/** A map member, typed — the shape every caller here actually wants. */
export const cborMapGet = (value: CborValue | undefined, key: number | string): CborValue | undefined =>
  value instanceof Map ? value.get(key) : undefined
