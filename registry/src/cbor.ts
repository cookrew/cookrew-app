/**
 * CBOR (RFC 8949), the subset WebAuthn actually speaks — and nothing else.
 *
 * A passkey's attestation object and its COSE public key are CBOR, so parsing
 * one is unavoidable; pulling in a CBOR library is not, and the registry ships
 * as a single dependency-free esbuild bundle. So this is a decoder, never an
 * encoder, written to be BOUNDED rather than complete: every length is checked
 * against the remaining bytes before it is trusted, nesting is capped, and the
 * indefinite-length forms are refused outright because no authenticator emits
 * them and accepting them is how a decoder ends up with an unbounded loop.
 *
 * It throws `CborError` on anything it does not understand. A caller that
 * treats a throw as "this is not a passkey" is behaving correctly: there is no
 * partial success here.
 */

export class CborError extends Error {}

export type CborValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | readonly CborValue[]
  | ReadonlyMap<CborValue, CborValue>

export interface CborLimits {
  /** Nesting cap. WebAuthn's deepest real shape is about four. */
  maxDepth: number
  /** Elements in one array or pairs in one map. */
  maxItems: number
  /** Bytes in one byte- or text-string. */
  maxStringBytes: number
}

export const DEFAULT_LIMITS: CborLimits = {
  maxDepth: 8,
  maxItems: 1024,
  maxStringBytes: 64 * 1024
}

/** What one decode consumed — the caller needs it to find what follows. */
export interface CborRead {
  value: CborValue
  /** Offset one past the last byte of this item. */
  end: number
}

/**
 * Decode ONE item starting at `at`, and say where it ended.
 *
 * The `end` is not a convenience. A COSE key sits at the tail of an
 * authenticator's attested credential data with extensions possibly after it,
 * and the only way to know where the key stops is to have the decoder say so.
 */
export function decodeCbor(
  bytes: Uint8Array,
  at = 0,
  limits: CborLimits = DEFAULT_LIMITS
): CborRead {
  return readItem(bytes, at, 0, limits)
}

/** Decode an item that must be the WHOLE input — a trailing byte is a refusal. */
export function decodeCborExact(
  bytes: Uint8Array,
  limits: CborLimits = DEFAULT_LIMITS
): CborValue {
  const read = decodeCbor(bytes, 0, limits)
  if (read.end !== bytes.byteLength) {
    throw new CborError(`trailing bytes after the item (${bytes.byteLength - read.end})`)
  }
  return read.value
}

interface HeadRead {
  major: number
  /** The argument, already widened from whatever additional-information form carried it. */
  value: number
  next: number
}

const need = (bytes: Uint8Array, at: number, count: number): void => {
  if (at + count > bytes.byteLength) throw new CborError('truncated')
}

function readHead(bytes: Uint8Array, at: number): HeadRead {
  need(bytes, at, 1)
  const initial = bytes[at]
  const major = initial >> 5
  const info = initial & 0x1f
  if (info < 24) return { major, value: info, next: at + 1 }
  if (info === 24) {
    need(bytes, at + 1, 1)
    return { major, value: bytes[at + 1], next: at + 2 }
  }
  if (info === 25) {
    need(bytes, at + 1, 2)
    return { major, value: (bytes[at + 1] << 8) | bytes[at + 2], next: at + 3 }
  }
  if (info === 26) {
    need(bytes, at + 1, 4)
    const value =
      bytes[at + 1] * 0x1000000 + (bytes[at + 2] << 16) + (bytes[at + 3] << 8) + bytes[at + 4]
    return { major, value, next: at + 5 }
  }
  if (info === 27) {
    // A 64-bit length exists in the specification and never in a passkey. It is
    // refused rather than read into a float, because a length that cannot be
    // represented exactly is a length no bounds check can be trusted about.
    throw new CborError('64-bit arguments are not accepted')
  }
  // 28–30 are reserved; 31 is the indefinite-length form.
  throw new CborError(`unsupported additional information ${info}`)
}

function readItem(
  bytes: Uint8Array,
  at: number,
  depth: number,
  limits: CborLimits
): CborRead {
  if (depth > limits.maxDepth) throw new CborError('nested too deep')
  const head = readHead(bytes, at)
  switch (head.major) {
    case 0:
      return { value: head.value, end: head.next }
    case 1:
      // Negative integers are -1 - n. COSE uses them for its labels (kty is 1,
      // crv is -1), so they are not exotic here.
      return { value: -1 - head.value, end: head.next }
    case 2: {
      if (head.value > limits.maxStringBytes) throw new CborError('byte string too long')
      need(bytes, head.next, head.value)
      return {
        value: bytes.slice(head.next, head.next + head.value),
        end: head.next + head.value
      }
    }
    case 3: {
      if (head.value > limits.maxStringBytes) throw new CborError('text string too long')
      need(bytes, head.next, head.value)
      const slice = bytes.slice(head.next, head.next + head.value)
      return {
        value: new TextDecoder('utf-8', { fatal: true }).decode(slice),
        end: head.next + head.value
      }
    }
    case 4: {
      if (head.value > limits.maxItems) throw new CborError('array too long')
      const items: CborValue[] = []
      let cursor = head.next
      for (let i = 0; i < head.value; i++) {
        const item = readItem(bytes, cursor, depth + 1, limits)
        items.push(item.value)
        cursor = item.end
      }
      return { value: items, end: cursor }
    }
    case 5: {
      if (head.value > limits.maxItems) throw new CborError('map too long')
      const map = new Map<CborValue, CborValue>()
      let cursor = head.next
      for (let i = 0; i < head.value; i++) {
        const key = readItem(bytes, cursor, depth + 1, limits)
        const value = readItem(bytes, key.end, depth + 1, limits)
        // A duplicate key is a malformed map, and silently keeping one of the
        // two is how two parsers disagree about the same bytes.
        if (map.has(key.value)) throw new CborError('duplicate map key')
        map.set(key.value, value.value)
        cursor = value.end
      }
      return { value: map, end: cursor }
    }
    case 7: {
      if (head.value === 20) return { value: false, end: head.next }
      if (head.value === 21) return { value: true, end: head.next }
      if (head.value === 22) return { value: null, end: head.next }
      throw new CborError(`unsupported simple value ${head.value}`)
    }
    default:
      // Major 6 is a semantic tag; nothing in WebAuthn's registration data is
      // tagged, and accepting one would mean deciding what it means.
      throw new CborError(`unsupported major type ${head.major}`)
  }
}

/** A map read, with the integer- and text-keyed lookups both spelled once. */
export function cborMap(value: CborValue): ReadonlyMap<CborValue, CborValue> | null {
  return value instanceof Map ? value : null
}
