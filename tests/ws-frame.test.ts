import { describe, expect, it } from 'vitest'
import { acceptKey, encodeTextFrame, decodeFrame, MAX_CLIENT_FRAME_BYTES, OVERSIZED_FRAME, OPCODE } from '../src/main/ws-frame'
import type { DecodedFrame } from '../src/main/ws-frame'

/** Narrow decodeFrame's union to a real frame (fails loudly otherwise). */
function frame(buf: Buffer): DecodedFrame {
  const r = decodeFrame(buf)
  if (r === null || r === OVERSIZED_FRAME) throw new Error('expected a decoded frame')
  return r
}

// Minimal, dependency-free WebSocket wire codec for the interactive-browser
// stream. Server frames go out unmasked; client frames arrive masked (browsers
// always mask). Only what the stream needs: text, close, ping.

describe('acceptKey', () => {
  it('matches the RFC 6455 example vector', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })
})

/** Build a masked client text frame the way a browser would send it. */
function maskedTextFrame(payload: string, maskKey = [0x12, 0x34, 0x56, 0x78]): Buffer {
  const data = Buffer.from(payload, 'utf8')
  const masked = Buffer.from(data.map((b, i) => b ^ maskKey[i % 4]))
  const header = data.length < 126 ? Buffer.from([0x81, 0x80 | data.length]) : (() => {
    const h = Buffer.alloc(4)
    h[0] = 0x81
    h[1] = 0x80 | 126
    h.writeUInt16BE(data.length, 2)
    return h
  })()
  return Buffer.concat([header, Buffer.from(maskKey), masked])
}

describe('encodeTextFrame', () => {
  it('emits an unmasked FIN text frame (small length inline)', () => {
    const f = encodeTextFrame('hi')
    expect(f[0]).toBe(0x81) // FIN + text
    expect(f[1]).toBe(2) // no mask bit, length 2
    expect(f.subarray(2).toString('utf8')).toBe('hi')
  })
  it('uses the 16-bit extended length for medium payloads', () => {
    const f = encodeTextFrame('x'.repeat(200))
    expect(f[1]).toBe(126)
    expect(f.readUInt16BE(2)).toBe(200)
    expect(f.subarray(4).toString('utf8')).toBe('x'.repeat(200))
  })
})

describe('decodeFrame', () => {
  it('unmasks a client text frame', () => {
    const r = frame(maskedTextFrame('hello'))
    expect(r.opcode).toBe(OPCODE.text)
    expect(r.payload.toString('utf8')).toBe('hello')
    expect(r.rest.length).toBe(0)
  })
  it('decodes a medium (126) masked frame', () => {
    const r = frame(maskedTextFrame('y'.repeat(300)))
    expect(r.payload.toString('utf8')).toBe('y'.repeat(300))
  })
  it('returns leftover bytes when two frames are coalesced', () => {
    const buf = Buffer.concat([maskedTextFrame('a'), maskedTextFrame('bb')])
    const first = frame(buf)
    expect(first.payload.toString('utf8')).toBe('a')
    const second = frame(first.rest)
    expect(second.payload.toString('utf8')).toBe('bb')
  })
  it('surfaces a close frame', () => {
    const r = frame(Buffer.from([0x88, 0x80, 0, 0, 0, 0]))
    expect(r.opcode).toBe(OPCODE.close)
  })
  it('null when the frame is incomplete (need more bytes)', () => {
    expect(decodeFrame(Buffer.from([0x81]))).toBeNull()
    expect(decodeFrame(Buffer.from([0x81, 0x85, 0x12]))).toBeNull() // masked len 5, truncated
  })

  it('rejects a frame declaring an oversized payload (DoS guard, HIGH-1)', () => {
    // 64-bit length header declaring 5 MB, masked bit set — must be refused
    // before the payload is buffered.
    const hdr = Buffer.alloc(14)
    hdr[0] = 0x81 // fin + text
    hdr[1] = 0x80 | 127 // masked + 64-bit length
    hdr.writeBigUInt64BE(BigInt(5 * 1024 * 1024), 2)
    expect(decodeFrame(hdr)).toBe(OVERSIZED_FRAME)
  })

  it('MAX_CLIENT_FRAME_BYTES is a sane small bound', () => {
    expect(MAX_CLIENT_FRAME_BYTES).toBeLessThanOrEqual(64 * 1024)
  })
})

