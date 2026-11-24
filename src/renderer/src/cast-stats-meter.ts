import { CAST_STATS_TYPE, type CastLine } from '../../shared/cast-stats'

/**
 * A LIVE VIEW'S NUMBERS, KEPT ON THE PHONE (cast-stats-meter.ts).
 *
 * The view tells this when a frame arrives, when one is drawn (or passed over
 * for a newer one, the line's receipt) and when the viewer's own input goes
 * out. `report` turns the stretch since the last report into the message the
 * Mac writes down (shared/cast-stats.ts). Pure: time is passed in.
 *
 * "Input to paint" is the wait from an input to the first frame drawn that
 * arrived after it — what a finger feels. One sample per input that a frame
 * answered; a burst of moves before one frame counts once, from its first.
 */

/** How often a phone reports while it watches. */
export const CAST_STATS_EVERY_MS = 5000
/** Frames remembered between arrival and draw; a line never has more in flight. */
const ARRIVALS_KEPT = 64

export interface CastStatsReport {
  readonly t: typeof CAST_STATS_TYPE
  readonly line: CastLine
  readonly windowMs: number
  readonly frames: number
  readonly painted: number
  readonly kbps: number
  readonly frameKB: number
  readonly paintP50: number
  readonly paintP95: number
  readonly inputP50: number
  readonly inputP95: number
  readonly inputs: number
  readonly dpr: number
  readonly scale: number
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Math.round(sorted[index])
}

export class CastStatsMeter {
  private since: number
  private frames = 0
  private bytes = 0
  private painted = 0
  private readonly arrivals = new Map<number, number>()
  private paintWaits: number[] = []
  private inputWaits: number[] = []
  private inputs = 0
  /** The input still waiting for a frame that arrived after it. */
  private pendingInputAt: number | null = null

  constructor(now: number) {
    this.since = now
  }

  frame(seq: number, bytes: number, at: number): void {
    this.frames += 1
    this.bytes += Math.max(0, bytes)
    this.arrivals.set(seq, at)
    while (this.arrivals.size > ARRIVALS_KEPT) {
      const oldest = this.arrivals.keys().next().value
      if (typeof oldest !== 'number') break
      this.arrivals.delete(oldest)
    }
  }

  paint(seq: number, at: number): void {
    const arrived = this.arrivals.get(seq)
    if (arrived === undefined) return
    this.arrivals.delete(seq)
    this.painted += 1
    this.paintWaits.push(at - arrived)
    if (this.pendingInputAt !== null && arrived >= this.pendingInputAt) {
      this.inputWaits.push(at - this.pendingInputAt)
      this.pendingInputAt = null
    }
  }

  input(at: number): void {
    this.inputs += 1
    if (this.pendingInputAt === null) this.pendingInputAt = at
  }

  /** The stretch since the last report, then a fresh one; null when nothing arrived in it. */
  report(now: number, line: CastLine, dpr: number, scale: number): CastStatsReport | null {
    const windowMs = Math.max(1, now - this.since)
    const result: CastStatsReport | null =
      this.frames === 0
        ? null
        : {
            t: CAST_STATS_TYPE,
            line,
            windowMs,
            frames: this.frames,
            painted: this.painted,
            kbps: Math.round((this.bytes / 1024 / (windowMs / 1000)) * 10) / 10,
            frameKB: Math.round((this.bytes / 1024 / this.frames) * 10) / 10,
            paintP50: percentile(this.paintWaits, 50),
            paintP95: percentile(this.paintWaits, 95),
            inputP50: percentile(this.inputWaits, 50),
            inputP95: percentile(this.inputWaits, 95),
            inputs: this.inputs,
            dpr: Math.round(dpr * 100) / 100,
            scale
          }
    this.since = now
    this.frames = 0
    this.bytes = 0
    this.painted = 0
    this.paintWaits = []
    this.inputWaits = []
    this.inputs = 0
    return result
  }
}

/** A frame's size in bytes, from main's bytes or a socket's data: URL (base64, ¾ of its length). */
export function frameByteSize(frame: { bytes?: Uint8Array; src?: string }): number {
  if (frame.bytes) return frame.bytes.byteLength
  if (!frame.src) return 0
  const comma = frame.src.indexOf(',')
  return Math.floor(((frame.src.length - comma - 1) * 3) / 4)
}
