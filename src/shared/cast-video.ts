/**
 * A LIVE VIEW AS H.264 (cast-video.ts): the words the phone and the Mac use.
 *
 * Measured 11-24 (h264-live-view-report): a JPEG screencast frame is the whole
 * picture every time, 100–136 KB, so the relay carried about one a second.
 * H.264 sends what changed: 5.6–13.5x fewer bytes on the same session, and
 * sharper at rest. So a viewer that can decode it gets it, and one that cannot
 * keeps JPEG, with nothing to choose on either side:
 *
 *   phone → Mac  { t: 'codecs', h264: true }   its VideoDecoder takes CAST_CODEC
 *   Mac → phone  { t: 'video', codec, scaleMax } from the next frame on, chunks
 *   Mac → phone  { t: 'vframe', seq, n, key, codec, w, h, data, meta }
 *   phone → Mac  { t: 'vack', n }   this chunk is decoded and drawn or passed over
 *   phone → Mac  { t: 'vkey' }      the chain broke here: start again from a key frame
 *
 * A chunk depends on the one before it, so nothing on the way may drop one
 * (socket-bridge-session.ts gives them their own ordered event). Pacing is the
 * Mac's: it encodes the newest picture only while few chunks are unacknowledged,
 * so a slow line means fewer frames, never a broken chain. `n` counts chunks
 * without gaps; a phone that sees one missing asks for a key frame.
 */

/** H.264 Main profile, level 5.1: up to a 3x phone's whole screen (1170x2532 is 11,766 macroblocks). */
export const CAST_CODEC = 'avc1.4d0033'

export const VIDEO_CODECS_TYPE = 'codecs'
export const VIDEO_ON_TYPE = 'video'
export const VIDEO_FRAME_TYPE = 'vframe'
export const VIDEO_ACK_TYPE = 'vack'
export const VIDEO_KEY_TYPE = 'vkey'

/** A browser card's H.264 chunk, as text: socket-bridge-session.ts sends these in order and keeps every one. */
export const isVideoChunk = (text: string): boolean => text.startsWith('{"t":"vframe"')

/** What a phone says it can decode; anything else is a viewer that keeps JPEG. */
export function sanitizeCodecs(raw: unknown): { h264: boolean } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as Record<string, unknown>
  if (msg.t !== VIDEO_CODECS_TYPE) return null
  return { h264: msg.h264 === true }
}

/** The chunk a phone acknowledges, or null for anything else. */
export function sanitizeVideoAck(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as Record<string, unknown>
  if (msg.t !== VIDEO_ACK_TYPE) return null
  const n = msg.n
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < Number.MAX_SAFE_INTEGER ? n : null
}

export function isVideoKeyAsk(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>).t === VIDEO_KEY_TYPE
}

/** One H.264 chunk as the phone reads it. */
export interface VideoChunkMessage {
  readonly seq: number
  readonly n: number
  readonly key: boolean
  readonly codec: string
  /** The picture's size in frame pixels: what it is drawn at and what input maps against. */
  readonly w: number
  readonly h: number
  /** The chunk, base64. */
  readonly data: string
}

const positiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER

/** A chunk's own fields, or null when it is not one (its frame meta is read like a JPEG frame's). */
export function readVideoChunk(obj: Record<string, unknown>): VideoChunkMessage | null {
  if (obj.t !== VIDEO_FRAME_TYPE) return null
  const { seq, n, w, h, data, codec } = obj
  if (!positiveInt(seq) || !positiveInt(n) || !positiveInt(w) || !positiveInt(h)) return null
  if (typeof data !== 'string' || data.length === 0 || typeof codec !== 'string' || !/^avc1\.[0-9a-f]{6}$/i.test(codec)) return null
  return { seq, n, key: obj.key === true, codec, w, h, data }
}
