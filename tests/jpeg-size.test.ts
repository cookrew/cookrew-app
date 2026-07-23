import { describe, expect, it } from 'vitest'
import { jpegSize } from '../src/main/jpeg-size'

// The screencast frame's pixel width sets displayScale (jpegWidth/deviceWidth),
// which maps a phone tap back to page CSS px. We read it straight from the SOF
// marker rather than decoding the whole image.

/** A tiny synthetic JPEG carrying just SOI + an SOF0 with a known size. */
function jpegWith(width: number, height: number, marker = 0xc0): Buffer {
  const sof = Buffer.alloc(10)
  sof[0] = 0xff
  sof[1] = marker // SOF0
  sof.writeUInt16BE(8, 2) // segment length
  sof[4] = 8 // precision
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof])
}

describe('jpegSize', () => {
  it('reads width/height from an SOF0 marker', () => {
    expect(jpegSize(jpegWith(390, 844))).toEqual({ width: 390, height: 844 })
  })
  it('skips a preceding segment (e.g. APP0) before the SOF', () => {
    const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), lenSeg(16)])
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, jpegWith(512, 300).subarray(2)])
    expect(jpegSize(buf)).toEqual({ width: 512, height: 300 })
  })
  it('handles progressive SOF2', () => {
    expect(jpegSize(jpegWith(200, 100, 0xc2))).toEqual({ width: 200, height: 100 })
  })
  it('null on non-JPEG or truncated input', () => {
    expect(jpegSize(Buffer.from([0x00, 0x01]))).toBeNull()
    expect(jpegSize(Buffer.from([0xff, 0xd8]))).toBeNull()
  })
})

/** A filler segment body of `n` bytes (length field included). */
function lenSeg(n: number): Buffer {
  const b = Buffer.alloc(n)
  b.writeUInt16BE(n, 0)
  return b
}
