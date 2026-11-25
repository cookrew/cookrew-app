import { MAX_ATTACHMENT_BYTES, type AttachLimit } from '../../../shared/attachment-limit'

/**
 * WHAT A PHONE DOES WITH A FILE BEFORE IT GOES UP: keep it, make it smaller,
 * or say why it cannot go. Pure, so every number here is tested without a
 * browser; the work itself is attach-video.ts and attach-image.ts.
 *
 * WeChat's way (2026-11-24, the owner: "压缩后上传，设置合理上限，参考微信"):
 * a video or a photo is compressed by default, the way a chat app sends one,
 * and only what still does not fit is refused. An agent reads a video by its
 * frames and a photo at well under 2048 pixels, so neither loses anything it
 * would have used.
 */

export type AttachKind = 'video' | 'image' | 'file'

const VIDEO_TYPES = /^video\//
const VIDEO_NAMES = /\.(mp4|m4v|mov|webm|3gp|mkv)$/i
/** What a canvas redraws faithfully. GIF (motion), HEIC (not every browser decodes it) and SVG go as they are. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const IMAGE_NAMES = /\.(jpe?g|png|webp)$/i

export const attachKind = (file: { readonly name: string; readonly type: string }): AttachKind => {
  if (VIDEO_TYPES.test(file.type) || (file.type === '' && VIDEO_NAMES.test(file.name))) return 'video'
  if (IMAGE_TYPES.has(file.type) || (file.type === '' && IMAGE_NAMES.test(file.name))) return 'image'
  return 'file'
}

/** Ten minutes: past that a clip is footage to hand over some other way, not a message. */
export const VIDEO_MAX_SECONDS = 10 * 60
/** 720p H.264 looks clean at this; above it the file grows and an agent sees nothing more. */
export const VIDEO_TOP_BPS = 2_500_000
/** Below this even 360p is mush: a video that would need less is too long for the path. */
export const VIDEO_FLOOR_BPS = 250_000
export const VIDEO_FPS = 30
const AUDIO_BPS = 96_000
const AUDIO_TIGHT_BPS = 48_000
/** A per-second budget under this gets the tight audio. */
const TIGHT_BPS = 600_000
/** Room for the container, and for an encoder that overshoots its bitrate a little. */
const MARGIN = 0.92
/** A clip already within this much of what it would become is sent as it is. */
const KEEP_SLACK = 1.15

/** The picture's long edge for a video bitrate: 720p, 540p or 360p. */
const longEdgeFor = (videoBps: number): number => (videoBps >= 1_200_000 ? 1280 : videoBps >= 600_000 ? 960 : 640)

export interface VideoFacts {
  readonly name: string
  readonly size: number
  readonly seconds: number
  /** As shown, rotation applied. */
  readonly width: number
  readonly height: number
}

export type VideoPlan =
  | { readonly kind: 'keep' }
  | {
      readonly kind: 'encode'
      readonly width: number
      readonly height: number
      readonly videoBps: number
      readonly audioBps: number
      readonly fps: number
    }
  | { readonly kind: 'refuse'; readonly reason: string }

/** `m:ss`, the way a phone's gallery shows a clip's length. */
export const clock = (seconds: number): string => {
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

/** Both sides scaled so the long one is at most `edge`, never up; even, as H.264 wants. */
const fitWithin = (width: number, height: number, edge: number): { width: number; height: number } => {
  const scale = Math.min(1, edge / Math.max(width, height))
  return { width: even(width * scale), height: even(height * scale) }
}

/** The longest clip a path carries, at the floor bitrate and the tight audio. */
const longestFor = (limit: AttachLimit): number =>
  Math.min(VIDEO_MAX_SECONDS, (limit.bytes * 8 * MARGIN) / (VIDEO_FLOOR_BPS + AUDIO_TIGHT_BPS))

/** The bitrates for a clip this long on this path: the top rate, or what the path's size leaves. */
const ratesFor = (seconds: number, limit: AttachLimit): { videoBps: number; audioBps: number } => {
  const perSecond = (limit.bytes * 8 * MARGIN) / seconds
  const audioBps = perSecond < TIGHT_BPS ? AUDIO_TIGHT_BPS : AUDIO_BPS
  return { videoBps: Math.floor(Math.min(VIDEO_TOP_BPS, perSecond - audioBps)), audioBps }
}

export const planVideo = (video: VideoFacts, limit: AttachLimit): VideoPlan => {
  const { name, size, seconds, width, height } = video
  // What already fits goes as it is: the rules below are for making a file
  // smaller, never a reason to refuse one that went before (a long screen
  // recording of a few megabytes, an hour of audio with a still picture).
  const fits = size <= limit.bytes
  if (seconds > VIDEO_MAX_SECONDS) {
    if (fits) return { kind: 'keep' }
    return { kind: 'refuse', reason: `${name} is ${clock(seconds)} long; a video can be up to ${clock(VIDEO_MAX_SECONDS)}` }
  }
  const { videoBps, audioBps } = ratesFor(Math.max(seconds, 1), limit)
  if (videoBps < VIDEO_FLOOR_BPS) {
    if (fits) return { kind: 'keep' }
    const direct = clock(longestFor({ bytes: MAX_ATTACHMENT_BYTES, via: 'mac' }))
    const said = `${name} is ${clock(seconds)} long; `
    return {
      kind: 'refuse',
      reason:
        limit.via === 'relay'
          ? `${said}through the relay a video can be up to ${clock(longestFor(limit))}. On the Mac's Wi-Fi or tailnet, up to ${direct}`
          : `${said}a video can be up to ${clock(longestFor(limit))}`
    }
  }
  const edge = longEdgeFor(videoBps)
  const asIs = fits && Math.max(width, height) <= edge && (size * 8) / Math.max(seconds, 1) <= (videoBps + audioBps) * KEEP_SLACK
  if (asIs) return { kind: 'keep' }
  return { kind: 'encode', ...fitWithin(width, height, edge), videoBps, audioBps, fps: VIDEO_FPS }
}

/**
 * A photo's pixels after compressing: 2048 x 2048's worth, more than an
 * agent's eyes use and a third of a phone camera's. Counted as an area, not a
 * long edge, so a tall scrolling screenshot is not cut to a sliver.
 */
export const IMAGE_PIXELS = 2048 * 2048
/** Never narrower than this on its short side (or than it was): the width a phone screenshot's text needs. */
export const IMAGE_SHORT_EDGE = 1080
/** A picture this small and of no more than IMAGE_PIXELS (with slack) is sent untouched: a screenshot, usually. */
const IMAGE_KEEP_BYTES = 1.5 * 1024 * 1024
const IMAGE_PIXEL_SLACK = 1.5
const JPEG_QUALITY = 0.85

export interface ImageFacts {
  readonly name: string
  readonly type: string
  readonly size: number
  readonly width: number
  readonly height: number
}

export type ImagePlan =
  | { readonly kind: 'keep' }
  | { readonly kind: 'encode'; readonly width: number; readonly height: number; readonly type: 'image/jpeg'; readonly quality: number }

export const planImage = (image: ImageFacts, limit: AttachLimit): ImagePlan => {
  const pixels = image.width * image.height
  if (image.size <= Math.min(IMAGE_KEEP_BYTES, limit.bytes) && pixels <= IMAGE_PIXELS * IMAGE_PIXEL_SLACK) return { kind: 'keep' }
  const short = Math.min(image.width, image.height)
  const byArea = Math.sqrt(IMAGE_PIXELS / pixels)
  const scale = Math.min(1, Math.max(byArea, Math.min(1, IMAGE_SHORT_EDGE / short)))
  return {
    kind: 'encode',
    width: Math.floor(image.width * scale),
    height: Math.floor(image.height * scale),
    type: 'image/jpeg',
    quality: JPEG_QUALITY
  }
}
