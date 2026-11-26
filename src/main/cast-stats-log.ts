import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { CastStats } from '../shared/cast-stats'

/**
 * WHERE A PHONE'S LIVE-VIEW NUMBERS ARE KEPT (cast-stats-log.ts).
 *
 * One JSON line per report: the phone's own numbers (shared/cast-stats.ts),
 * what the Mac sent it over the same stretch, and the settings in force, so two
 * settings can be compared on the same phone and page afterwards. Numbers
 * only — the card is named by its id, never by page or address. The file
 * stays small: past LOG_MAX_BYTES it becomes `.1` and starts again.
 */

export const LOG_MAX_BYTES = 1_000_000

/** What the Mac itself saw of one viewer over the report's window. */
export interface CastSent {
  readonly frames: number
  readonly kbps: number
  /** The last frame's pixel size, which says what scale actually reached the phone. */
  readonly width: number
  readonly height: number
}

/** The settings actually in force for this viewer when it reported. */
export interface CastInUse {
  readonly scaleMax: number
  /** The quality the running screencast was started with; 0 before one started. */
  readonly quality: number
}

/** An H.264 viewer's Mac-side timings over the report's window, in ms (cast-video-out.ts). */
export interface CastVideoTimings {
  readonly windowKB: number
  readonly encodeP50: number
  readonly encodeP95: number
  /** A picture held, waiting for the window or the encoder. */
  readonly waitP50: number
  readonly waitP95: number
  /** Chunk sent to its acknowledgement back. */
  readonly ackP50: number
  readonly ackP95: number
  /** What the pacing did in the window (absent in reports from before 0.6.43). */
  readonly keyAsks?: number
  readonly keyFrames?: number
  readonly writeOffs?: number
  /** Key asks plus the estimate's own new-network forgets (forgets alone = lineResets - keyAsks). */
  readonly lineResets?: number
  /** The line estimate at the report: KB/s, its own round trip, the startup/drain gain. */
  readonly speedKBps?: number
  readonly rttMs?: number
  readonly gain?: number
}

/**
 * The viewport this viewer asked for (absent until it first asks; from 0.6.48):
 * the window's offers and claims, and its last ask's CSS size and scale as it
 * arrived (sanitized, before this Mac held the scale to inUse.scaleMax). A
 * phone whose view flips size shows here whether it was the phone that asked.
 */
export interface CastAsks {
  readonly offers: number
  readonly claims: number
  readonly width: number
  readonly height: number
  readonly scale: number
}

export interface CastStatsEntry {
  readonly at: string
  readonly browserId: string
  readonly viewer: string
  readonly relayed: boolean
  readonly phone: CastStats
  readonly sent: CastSent
  readonly inUse: CastInUse
  readonly video?: CastVideoTimings
  readonly asks?: CastAsks
}

export function castStatsFile(): string {
  return path.join(homedir(), '.cookrew', 'logs', 'cast-stats.jsonl')
}

export function appendCastStats(entry: CastStatsEntry, file: string = castStatsFile()): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      // No file yet.
    }
    if (size > LOG_MAX_BYTES) renameSync(file, `${file}.1`)
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  } catch (error) {
    console.error('A live view report could not be written:', error)
  }
}
