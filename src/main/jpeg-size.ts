// Read a JPEG's pixel dimensions from its SOF marker without decoding the
// image. The interactive-browser stream needs the frame width to compute
// displayScale (jpegWidth / page deviceWidth) for tap mapping.

/** SOF markers that carry frame dimensions (baseline, progressive, etc.). */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

export interface Size {
  width: number
  height: number
}

/** Pixel size of a JPEG buffer, or null if it isn't a parseable JPEG. */
export function jpegSize(buf: Buffer): Size | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null // SOI
  let offset = 2
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buf[offset + 1]
    if (SOF_MARKERS.has(marker)) {
      // SOF: [FF Cx][len:2][precision:1][height:2][width:2]
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
    }
    // Standalone markers (no length) — skip the marker itself.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    // Length-prefixed segment — jump past it.
    const segLen = buf.readUInt16BE(offset + 2)
    offset += 2 + segLen
  }
  return null
}
