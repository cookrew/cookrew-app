// Minimal WebSocket (RFC 6455) wire codec — just what the interactive-browser
// stream needs, no dependency. The stream is server-push heavy (base64 JPEG
// frames, unmasked) with a thin masked client->server input channel; we handle
// text/close/ping and defer fragmentation (input messages are tiny and never
// fragmented; server frames are emitted whole).

import { createHash } from 'node:crypto'

/** GUID appended to the client key per RFC 6455 §4.2.2. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa
} as const

/** Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key. */
export function acceptKey(secWebSocketKey: string): string {
  return createHash('sha1').update(secWebSocketKey + WS_GUID).digest('base64')
}

/** Encode a server->client TEXT frame (FIN set, unmasked). */
export function encodeTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8')
  const len = data.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x80 | OPCODE.text, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | OPCODE.text
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | OPCODE.text
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, data])
}

/** Encode an unmasked control frame (pong/close) carrying a small payload. */
export function encodeControlFrame(opcode: number, payload: Uint8Array = new Uint8Array(0)): Buffer {
  const len = Math.min(payload.length, 125) // control frames are ≤125 bytes
  return Buffer.concat([Buffer.from([0x80 | opcode, len]), payload.subarray(0, len)])
}

export interface DecodedFrame {
  fin: boolean
  opcode: number
  payload: Buffer
  /** Bytes after this frame (a coalesced next frame, or empty). */
  rest: Buffer
}

/**
 * Max client frame payload. Client→server frames are tiny input JSON; a frame
 * declaring more than this is hostile (a huge declared length would otherwise
 * grow the inbound buffer without bound → main-process OOM). Signalled as a
 * distinct oversized result so the caller tears the socket down.
 */
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024

/** decodeFrame returns this sentinel when a frame declares an illegal size. */
export const OVERSIZED_FRAME = Symbol('oversized-frame')

/**
 * Decode ONE frame from the front of `buf`. Returns null when more bytes are
 * needed, OVERSIZED_FRAME when a frame declares an illegal payload size (the
 * caller must destroy the socket), else the frame. Client frames are required
 * to be masked (per spec); an unmasked client frame returns null.
 */
export function decodeFrame(buf: Buffer): DecodedFrame | typeof OVERSIZED_FRAME | null {
  if (buf.length < 2) return null
  const fin = (buf[0] & 0x80) !== 0
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < offset + 2) return null
    len = buf.readUInt16BE(offset)
    offset += 2
  } else if (len === 127) {
    if (buf.length < offset + 8) return null
    len = Number(buf.readBigUInt64BE(offset))
    offset += 8
  }
  // Reject before buffering the declared bytes — a hostile huge length must
  // never accumulate in the inbound buffer.
  if (len > MAX_CLIENT_FRAME_BYTES) return OVERSIZED_FRAME
  if (!masked) return null // clients MUST mask; refuse anything else
  if (buf.length < offset + 4 + len) return null
  const maskKey = buf.subarray(offset, offset + 4)
  offset += 4
  const raw = buf.subarray(offset, offset + len)
  const payload = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i += 1) payload[i] = raw[i] ^ maskKey[i % 4]
  return { fin, opcode, payload, rest: buf.subarray(offset + len) }
}
