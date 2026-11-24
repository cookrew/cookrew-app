// WHAT A PHONE DOES WITH A FILE BEFORE IT GOES UP (prompt/attach-plan.ts):
// keep it, make it smaller, or say why it cannot go. WeChat's way: a video
// or a photo is compressed by default, sized to what the path carries.
import { describe, expect, it } from 'vitest'
import {
  attachKind,
  IMAGE_PIXELS,
  IMAGE_SHORT_EDGE,
  planImage,
  planVideo,
  VIDEO_MAX_SECONDS,
  VIDEO_TOP_BPS
} from '../src/renderer/src/prompt/attach-plan'
import { MAC_LIMIT, MAX_ATTACHMENT_BYTES, RELAY_LIMIT } from '../src/shared/attachment-limit'

const MB = 1024 * 1024

describe('what kind of file it is', () => {
  it('reads the type, and the name when a picker gives no type', () => {
    expect(attachKind({ name: 'a.mp4', type: 'video/mp4' })).toBe('video')
    expect(attachKind({ name: 'IMG_0001.MOV', type: '' })).toBe('video')
    expect(attachKind({ name: 'shot.png', type: 'image/png' })).toBe('image')
    expect(attachKind({ name: 'photo.JPG', type: '' })).toBe('image')
    expect(attachKind({ name: 'scan.webp', type: 'image/webp' })).toBe('image')
    // Pictures a canvas cannot be trusted to redraw are sent as they are.
    expect(attachKind({ name: 'a.gif', type: 'image/gif' })).toBe('file')
    expect(attachKind({ name: 'a.heic', type: 'image/heic' })).toBe('file')
    expect(attachKind({ name: 'a.svg', type: 'image/svg+xml' })).toBe('file')
    expect(attachKind({ name: 'notes.pdf', type: 'application/pdf' })).toBe('file')
  })
})

describe('a video', () => {
  const phoneClip = { name: 'clip.mp4', size: 180 * MB, seconds: 60, width: 1920, height: 1080 }

  it('is the Mac cap of 100 MB that a compressed video must fit', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(100 * MB)
  })

  it('from a phone camera becomes 720p at the top bitrate, 30 frames a second', () => {
    const plan = planVideo(phoneClip, MAC_LIMIT)
    expect(plan).toMatchObject({ kind: 'encode', width: 1280, height: 720, videoBps: VIDEO_TOP_BPS, fps: 30 })
  })

  it('keeps its shape on its side: a portrait clip is 720 wide', () => {
    const plan = planVideo({ ...phoneClip, width: 1080, height: 1920 }, MAC_LIMIT)
    expect(plan).toMatchObject({ kind: 'encode', width: 720, height: 1280 })
  })

  it('is never made larger, and its sides stay even (H.264 wants that)', () => {
    const plan = planVideo({ ...phoneClip, size: 30 * MB, width: 854, height: 481 }, MAC_LIMIT)
    expect(plan).toMatchObject({ kind: 'encode', width: 854, height: 480 })
  })

  it('is sent as it is when it is already as small as compressing would make it', () => {
    // 60 s at ~1.3 Mbps, 640x360: nothing to win.
    expect(planVideo({ ...phoneClip, size: 10 * MB, width: 640, height: 360 }, MAC_LIMIT)).toEqual({ kind: 'keep' })
  })

  it('fits the relay: a lower bitrate and a smaller picture, under 4 MB', () => {
    const plan = planVideo({ ...phoneClip, seconds: 30 }, RELAY_LIMIT)
    expect(plan.kind).toBe('encode')
    if (plan.kind !== 'encode') return
    const bytes = ((plan.videoBps + plan.audioBps) * 30) / 8
    expect(bytes).toBeLessThan(RELAY_LIMIT.bytes)
    expect(Math.max(plan.width, plan.height)).toBeLessThan(1280)
  })

  it('too long for the relay says how long the relay takes, and that the Wi-Fi takes more', () => {
    const plan = planVideo({ ...phoneClip, seconds: 300 }, RELAY_LIMIT)
    expect(plan.kind).toBe('refuse')
    if (plan.kind !== 'refuse') return
    expect(plan.reason).toMatch(/^clip\.mp4 is 5:00 long; through the relay a video can be up to 1:\d\d\. On the Mac's Wi-Fi or tailnet, up to 10:00$/)
  })

  it(`stops at ${VIDEO_MAX_SECONDS / 60} minutes on any path`, () => {
    expect(planVideo({ ...phoneClip, seconds: VIDEO_MAX_SECONDS }, MAC_LIMIT).kind).toBe('encode')
    expect(planVideo({ ...phoneClip, seconds: 14 * 60 + 5 }, MAC_LIMIT)).toEqual({
      kind: 'refuse',
      reason: 'clip.mp4 is 14:05 long; a video can be up to 10:00'
    })
  })

  it('that already fits is sent as it is, however long — it went before, it goes now', () => {
    // A 2-minute screen recording of 3 MB on the relay: no bitrate would fit it smaller, and it needs none.
    expect(planVideo({ name: 'rec.mp4', size: 3 * MB, seconds: 120, width: 1080, height: 2340 }, RELAY_LIMIT)).toEqual({ kind: 'keep' })
    // Twelve minutes, 40 MB, on the direct path: past the length rule, but within the cap.
    expect(planVideo({ ...phoneClip, size: 40 * MB, seconds: 12 * 60 }, MAC_LIMIT)).toEqual({ kind: 'keep' })
  })

  it('ten minutes on the direct path still fits the cap', () => {
    const plan = planVideo({ ...phoneClip, seconds: VIDEO_MAX_SECONDS }, MAC_LIMIT)
    if (plan.kind !== 'encode') throw new Error('expected an encode')
    expect(((plan.videoBps + plan.audioBps) * VIDEO_MAX_SECONDS) / 8).toBeLessThan(MAX_ATTACHMENT_BYTES)
  })
})

describe('a picture', () => {
  it('a phone photo comes down to about four megapixels as JPEG, its shape kept', () => {
    const plan = planImage({ name: 'IMG.jpg', type: 'image/jpeg', size: 5 * MB, width: 4032, height: 3024 }, MAC_LIMIT)
    expect(plan).toEqual({ kind: 'encode', width: 2364, height: 1773, type: 'image/jpeg', quality: 0.85 })
    if (plan.kind !== 'encode') return
    expect(plan.width * plan.height).toBeLessThanOrEqual(IMAGE_PIXELS)
  })

  it('a tall scrolling screenshot keeps the width its text needs', () => {
    // 1080 x 8000 cut to a 2048 long edge would be 276 wide: unreadable.
    const plan = planImage({ name: 'long.png', type: 'image/png', size: 6 * MB, width: 1080, height: 8000 }, MAC_LIMIT)
    expect(plan).toEqual({ kind: 'encode', width: 1080, height: 8000, type: 'image/jpeg', quality: 0.85 })
    const wide = planImage({ name: 'long.png', type: 'image/png', size: 6 * MB, width: 1440, height: 9000 }, MAC_LIMIT)
    expect(wide).toMatchObject({ kind: 'encode', width: IMAGE_SHORT_EDGE, height: 6750 })
  })

  it('a screenshot of ordinary size is sent untouched', () => {
    expect(planImage({ name: 's.png', type: 'image/png', size: 900 * 1024, width: 1080, height: 2340 }, MAC_LIMIT)).toEqual({
      kind: 'keep'
    })
  })

  it('a heavy one of small size is re-encoded at its own size', () => {
    const plan = planImage({ name: 'big.png', type: 'image/png', size: 6 * MB, width: 1600, height: 1200 }, MAC_LIMIT)
    expect(plan).toEqual({ kind: 'encode', width: 1600, height: 1200, type: 'image/jpeg', quality: 0.85 })
  })

  it('on the relay, one under the old ceiling but over the relay is still made smaller', () => {
    const plan = planImage({ name: 'p.jpg', type: 'image/jpeg', size: 1.2 * MB, width: 1500, height: 1000 }, RELAY_LIMIT)
    expect(plan.kind).toBe('keep')
    const big = planImage({ name: 'p.jpg', type: 'image/jpeg', size: 4.5 * MB, width: 1500, height: 1000 }, RELAY_LIMIT)
    expect(big.kind).toBe('encode')
  })
})
