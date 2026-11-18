/** Byte helpers for cookrew-seal/2: WebCrypto-friendly, no Node Buffer. */

export type Bytes = Uint8Array<ArrayBuffer>

const encoder = new TextEncoder()
/** Fatal: a field that is not UTF-8 is not a field. */
const strictDecoder = new TextDecoder('utf-8', { fatal: true })

export const utf8 = (text: string): Bytes => encoder.encode(text) as Bytes

/** Null for bytes that are not UTF-8. */
export const fromUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return strictDecoder.decode(bytes)
  } catch {
    return null
  }
}

export const concat = (...parts: readonly Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  parts.reduce((at, part) => {
    out.set(part, at)
    return at + part.length
  }, 0)
  return out
}

export const u8 = (value: number): Bytes => Uint8Array.of(value & 0xff)

export const u16 = (value: number): Bytes => {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, value)
  return out
}

export const u32 = (value: number): Bytes => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

/** Up to 2^53: every sequence number and ack fits. */
export const u64 = (value: number): Bytes => {
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setUint32(0, Math.floor(value / 0x100000000))
  view.setUint32(4, value % 0x100000000)
  return out
}

/** Null past 2^53, which no count here reaches. */
export const readU64 = (view: DataView, at: number): number | null => {
  const high = view.getUint32(at)
  if (high >= 0x200000) return null
  return high * 0x100000000 + view.getUint32(at + 4)
}

export const toB64u = (data: Uint8Array): string => {
  let binary = ''
  for (let at = 0; at < data.length; at += 0x8000) binary += String.fromCharCode(...data.subarray(at, at + 0x8000))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Null unless it is base64url spelled the one way: two spellings of one key are two keys to a cache. */
export const fromB64u = (text: unknown): Bytes | null => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return null
  try {
    const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
    return toB64u(bytes) === text ? bytes : null
  } catch {
    return null
  }
}

export const sha256 = async (...parts: readonly Uint8Array[]): Promise<Bytes> => new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts)))

export const hkdf = async (ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Promise<Bytes> => {
  const key = await crypto.subtle.importKey('raw', concat(ikm), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: concat(salt), info: utf8(info) }, key, length * 8))
}

/** Constant time over equal lengths. */
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}
