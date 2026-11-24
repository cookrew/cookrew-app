// THE ATTACHMENT CAP, said on the phone before a byte goes up
// (shared/attachment-limit.ts). Past it the Mac refuses the upload anyway,
// but only after the phone has sent megabytes and with a transport's word
// (`body-too-large`) instead of the file's name and the limit.
import { describe, expect, it } from 'vitest'
import {
  MAC_LIMIT,
  MAX_ATTACHMENT_BYTES,
  oversizeAttachment,
  RELAY_BODY_MAX,
  RELAY_LIMIT
} from '../src/shared/attachment-limit'
import { MAX_ATTACHMENT_BYTES as SAVE_CAP } from '../src/main/attachments'
import { BRIDGE_BODY_MAX } from '../src/main/canvas-bridge'
import { CANVAS_BODY_MAX } from '../registry/src/v2-canvas-relay'

const MB = 1024 * 1024

describe('the attachment cap', () => {
  it('is the one the Mac saves by', () => {
    expect(SAVE_CAP).toBe(MAX_ATTACHMENT_BYTES)
  })

  it('is the relay\'s on the relay — the registry\'s and the Mac bridge\'s own number', () => {
    expect(RELAY_BODY_MAX).toBe(CANVAS_BODY_MAX)
    expect(RELAY_BODY_MAX).toBe(BRIDGE_BODY_MAX)
    expect(RELAY_LIMIT.bytes).toBe(RELAY_BODY_MAX)
  })

  it('lets through files at or under it', () => {
    expect(oversizeAttachment([])).toBeNull()
    expect(oversizeAttachment([{ name: 'a.png', size: 1 }, { name: 'clip.mp4', size: MAX_ATTACHMENT_BYTES }])).toBeNull()
    expect(oversizeAttachment([{ name: 'a.png', size: RELAY_BODY_MAX }], RELAY_LIMIT)).toBeNull()
  })

  it('names the first file over it, its size and the limit', () => {
    const said = oversizeAttachment([
      { name: 'a.png', size: 2 * MB },
      { name: 'clip.mp4', size: 134.6 * MB },
      { name: 'b.mov', size: 190 * MB }
    ])
    expect(said).toBe('clip.mp4 is 134.6 MB; the Mac takes attachments up to 100 MB')
  })

  it('never says a file just over the limit is the limit', () => {
    expect(oversizeAttachment([{ name: 'v.mp4', size: MAX_ATTACHMENT_BYTES + 300 * 1024 }], MAC_LIMIT)).toBe(
      'v.mp4 is 100.3 MB; the Mac takes attachments up to 100 MB'
    )
  })

  it('says "a file" for one with no name', () => {
    expect(oversizeAttachment([{ name: '', size: 121 * MB }])).toBe('a file is 121 MB; the Mac takes attachments up to 100 MB')
  })

  it('on the relay, says the relay is the limit and a direct path takes more', () => {
    expect(oversizeAttachment([{ name: 'clip.mp4', size: 10.2 * MB }], RELAY_LIMIT)).toBe(
      "clip.mp4 is 10.2 MB; through the relay attachments stop at 4 MB. On the Mac's Wi-Fi or tailnet they go up to 100 MB"
    )
    // Too large for any path: the Mac's cap is the one worth saying.
    expect(oversizeAttachment([{ name: 'long.mov', size: 180 * MB }], RELAY_LIMIT)).toBe(
      'long.mov is 180 MB; the Mac takes attachments up to 100 MB'
    )
  })
})
