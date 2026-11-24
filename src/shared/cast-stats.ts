/**
 * HOW A LIVE VIEW IS DOING, AS THE PHONE SEES IT (cast-stats.ts).
 *
 * A phone watching a browser card sends one of these every few seconds
 * (renderer/cast-stats-meter.ts), and the Mac writes it down
 * (main/cast-stats-log.ts) beside what it sent. It is numbers only: no page,
 * no URL, no text, nothing a viewer typed. The Mac takes nothing on trust:
 * every field is bounded here, and a message that is not this shape is dropped.
 */

export const CAST_STATS_TYPE = 'stats'

/** How the frames reached the viewer: main's port, a socket, the direct data channel, the relay. */
export const CAST_LINES = ['port', 'ws', 'link', 'relay'] as const
export type CastLine = (typeof CAST_LINES)[number]

/** How the pictures were sent (cast-video.ts). A report from before H.264 says nothing, and was JPEG. */
export const CAST_STATS_CODECS = ['jpeg', 'h264'] as const
export type CastStatsCodec = (typeof CAST_STATS_CODECS)[number]

export interface CastStats {
  readonly line: CastLine
  readonly codec: CastStatsCodec
  /** The window these numbers cover. */
  readonly windowMs: number
  /** Frames that arrived, and frames drawn (or passed over for a newer one). */
  readonly frames: number
  readonly painted: number
  /** What arrived, in kilobytes per second, and per frame. */
  readonly kbps: number
  readonly frameKB: number
  /** Arrival → drawn, in ms. */
  readonly paintP50: number
  readonly paintP95: number
  /** The viewer's input → the next frame drawn after it, in ms; 0 with no input. */
  readonly inputP50: number
  readonly inputP95: number
  readonly inputs: number
  /** The viewer's screen pixel ratio, and the scale its viewport asked for. */
  readonly dpr: number
  readonly scale: number
}

const MAX_MS = 120_000
const MAX_COUNT = 100_000
const MAX_KB = 1_000_000

function bounded(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.min(Math.round(value * 10) / 10, max)
}

/** A stats message from a viewer, held to its shape and bounds; null when it is anything else. */
export function sanitizeCastStats(raw: unknown): CastStats | null {
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as Record<string, unknown>
  if (msg.t !== CAST_STATS_TYPE) return null
  const line = CAST_LINES.find((kind) => kind === msg.line)
  if (!line) return null
  const numbers = {
    windowMs: bounded(msg.windowMs, MAX_MS),
    frames: bounded(msg.frames, MAX_COUNT),
    painted: bounded(msg.painted, MAX_COUNT),
    kbps: bounded(msg.kbps, MAX_KB),
    frameKB: bounded(msg.frameKB, MAX_KB),
    paintP50: bounded(msg.paintP50, MAX_MS),
    paintP95: bounded(msg.paintP95, MAX_MS),
    inputP50: bounded(msg.inputP50, MAX_MS),
    inputP95: bounded(msg.inputP95, MAX_MS),
    inputs: bounded(msg.inputs, MAX_COUNT),
    dpr: bounded(msg.dpr, 8),
    scale: bounded(msg.scale, 8)
  }
  const values = Object.values(numbers)
  if (values.some((value) => value === null)) return null
  const codec = CAST_STATS_CODECS.find((kind) => kind === msg.codec) ?? 'jpeg'
  return { line, codec, ...(numbers as { [K in keyof typeof numbers]: number }) }
}
