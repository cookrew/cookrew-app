import { concat, fromUtf8, readU64, u16, u32, u64, u8, utf8, type Bytes } from './bytes'
import { DATA_MAX, FIELDS_MAX_BYTES, FIELDS_MAX_COUNT, FRAME_HEAD_BYTES, REASON_MAX_BYTES } from './spec'

/**
 * COOKREW-SEAL/2 FRAMES (spec.ts §4): binary, one per record. Decoding is
 * strict and total: anything that is not exactly a frame is null, because the
 * peer holding the keys is still not trusted to write one.
 */

export type Fields = Readonly<Record<string, string>>

export type Frame2 =
  | { readonly kind: 'open'; readonly stream: number; readonly type: string; readonly fields: Fields }
  | { readonly kind: 'head'; readonly stream: number; readonly status: number; readonly fields: Fields }
  | { readonly kind: 'data'; readonly stream: number; readonly data: Uint8Array }
  | { readonly kind: 'end'; readonly stream: number }
  | { readonly kind: 'abort'; readonly stream: number; readonly code: number; readonly reason: string }
  | { readonly kind: 'ack'; readonly stream: 0; readonly next: number }
  | { readonly kind: 'ping'; readonly stream: 0 }
  | { readonly kind: 'credit'; readonly stream: number; readonly bytes: number }
  | { readonly kind: 'goaway'; readonly stream: 0; readonly code: number; readonly reason: string }

const TYPES = ['open', 'head', 'data', 'end', 'abort', 'ack', 'ping', 'credit', 'goaway'] as const
const SESSION_KINDS = new Set(['ack', 'ping', 'goaway'])

export const STREAM_KIND = /^[a-z][a-z0-9-]{0,31}$/
/** Header names as HTTP/2 writes them, lower case, and pseudo-fields with a leading colon. */
const FIELD_NAME = /^:?[!#$%&'*+.^_`|~0-9a-z-]+$/

/** Callers name things by plain property: a field called "__proto__" is refused, not merged. */
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
/** Kinds are looked up by name (own entries only, canvas-seal-terminus.ts); these are refused besides, to be plain. */
const RESERVED_KINDS = new Set([...RESERVED, 'hasownproperty', 'tostring', 'valueof'])

/** A kind is a lane's name: never one every object already answers to. */
export const isStreamKind = (kind: string): boolean => STREAM_KIND.test(kind) && !RESERVED_KINDS.has(kind)

export function encodeFields(fields: Fields): Bytes {
  const entries = Object.entries(fields)
  if (entries.length > FIELDS_MAX_COUNT) throw new Error('Too many fields')
  const parts: Uint8Array[] = [u16(entries.length)]
  for (const [name, value] of entries) {
    if (!FIELD_NAME.test(name) || RESERVED.has(name)) throw new Error(`Not a field name: ${name}`)
    const nameBytes = utf8(name)
    const valueBytes = utf8(value)
    parts.push(u16(nameBytes.length), nameBytes, u32(valueBytes.length), valueBytes)
  }
  const out = concat(...parts)
  if (out.length > FIELDS_MAX_BYTES) throw new Error('These fields are too large')
  return out
}

function decodeFields(bytes: Uint8Array): Fields | null {
  if (bytes.length > FIELDS_MAX_BYTES || bytes.length < 2) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint16(0)
  if (count > FIELDS_MAX_COUNT) return null
  const out: Record<string, string> = Object.create(null) as Record<string, string>
  let at = 2
  for (let index = 0; index < count; index += 1) {
    if (at + 2 > bytes.length) return null
    const nameLength = view.getUint16(at)
    at += 2
    if (at + nameLength + 4 > bytes.length) return null
    const name = fromUtf8(bytes.subarray(at, at + nameLength))
    at += nameLength
    const valueLength = view.getUint32(at)
    at += 4
    if (at + valueLength > bytes.length) return null
    const value = fromUtf8(bytes.subarray(at, at + valueLength))
    at += valueLength
    if (name === null || value === null || !FIELD_NAME.test(name) || RESERVED.has(name) || name in out) return null
    out[name] = value
  }
  return at === bytes.length ? { ...out } : null
}

const coded = (code: number, reason: string): Bytes => {
  const text = utf8(reason)
  if (text.length > REASON_MAX_BYTES) throw new Error('This reason is too long')
  return concat(u16(code), text)
}

function bodyOf(frame: Frame2): Uint8Array {
  switch (frame.kind) {
    case 'open': {
      if (!isStreamKind(frame.type)) throw new Error(`Not a stream kind: ${frame.type}`)
      return concat(u8(frame.type.length), utf8(frame.type), encodeFields(frame.fields))
    }
    case 'head':
      return concat(u16(frame.status), encodeFields(frame.fields))
    case 'data':
      if (frame.data.length === 0 || frame.data.length > DATA_MAX) throw new Error('A data frame carries 1 to DATA_MAX bytes')
      return frame.data
    case 'abort':
    case 'goaway':
      return coded(frame.code, frame.reason)
    case 'ack':
      return u64(frame.next)
    case 'credit':
      return u32(frame.bytes)
    case 'end':
    case 'ping':
      return new Uint8Array(0)
  }
}

export function encodeFrame2(frame: Frame2): Bytes {
  const sessionWide = SESSION_KINDS.has(frame.kind)
  if (sessionWide !== (frame.stream === 0)) throw new Error(`A ${frame.kind} frame cannot name stream ${frame.stream}`)
  if (!Number.isInteger(frame.stream) || frame.stream < 0 || frame.stream > 0xffffffff) throw new Error('Not a stream id')
  return concat(u8(TYPES.indexOf(frame.kind) + 1), u32(frame.stream), bodyOf(frame))
}

const readCoded = (body: Uint8Array): { code: number; reason: string } | null => {
  if (body.length < 2 || body.length > 2 + REASON_MAX_BYTES) return null
  const reason = fromUtf8(body.subarray(2))
  return reason === null ? null : { code: (body[0] << 8) | body[1], reason }
}

const isStatus = (status: number): boolean => status >= 100 && status <= 599

function decodeStreamFrame(kind: (typeof TYPES)[number], stream: number, body: Uint8Array): Frame2 | null {
  switch (kind) {
    case 'open': {
      const length = body[0] ?? 0
      const type = String.fromCharCode(...body.subarray(1, 1 + length))
      if (body.length < 1 + length || !isStreamKind(type) || type.length !== length) return null
      const fields = decodeFields(body.subarray(1 + length))
      return fields === null ? null : { kind, stream, type, fields }
    }
    case 'head': {
      if (body.length < 2) return null
      const status = (body[0] << 8) | body[1]
      const fields = decodeFields(body.subarray(2))
      return fields === null || !isStatus(status) ? null : { kind, stream, status, fields }
    }
    // Never empty: an empty one would cost no credit, so a peer could queue them without end.
    case 'data':
      return body.length === 0 || body.length > DATA_MAX ? null : { kind, stream, data: body.slice() }
    case 'end':
      return body.length === 0 ? { kind, stream } : null
    case 'abort': {
      const read = readCoded(body)
      return read === null ? null : { kind, stream, ...read }
    }
    case 'credit': {
      if (body.length !== 4) return null
      const bytes = new DataView(body.buffer, body.byteOffset, 4).getUint32(0)
      return bytes === 0 ? null : { kind, stream, bytes }
    }
    default:
      return null
  }
}

function decodeSessionFrame(kind: (typeof TYPES)[number], body: Uint8Array): Frame2 | null {
  switch (kind) {
    case 'ack': {
      if (body.length !== 8) return null
      const next = readU64(new DataView(body.buffer, body.byteOffset, 8), 0)
      return next === null ? null : { kind, stream: 0, next }
    }
    case 'ping':
      return body.length === 0 ? { kind, stream: 0 } : null
    case 'goaway': {
      const read = readCoded(body)
      return read === null ? null : { kind, stream: 0, ...read }
    }
    default:
      return null
  }
}

export function decodeFrame2(raw: Uint8Array): Frame2 | null {
  if (raw.length < FRAME_HEAD_BYTES) return null
  const kind = TYPES[raw[0] - 1]
  if (kind === undefined) return null
  const stream = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(1)
  const body = raw.subarray(FRAME_HEAD_BYTES)
  if (SESSION_KINDS.has(kind)) return stream === 0 ? decodeSessionFrame(kind, body) : null
  return stream === 0 ? null : decodeStreamFrame(kind, stream, body)
}
