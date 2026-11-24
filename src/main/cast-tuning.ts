import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { VIEWPORT_SCALE_MAX } from '../shared/cast-viewport'

/**
 * THE LIVE VIEW'S TWO KNOBS, TURNED WITHOUT A RELEASE (cast-tuning.ts).
 *
 * How sharp a phone's picture of a card is costs bytes, and the right trade
 * depends on the line it rides (a LAN, the direct link, the relay). The two
 * numbers that set it live in ~/.cookrew/cast-tuning.json so they can be tried
 * on a real phone and compared by its stats (cast-stats-log.ts), not guessed:
 *
 *   scaleMax       device pixels per CSS px a viewer may ask for (1–3, half steps)
 *   relayScaleMax  the same for a viewer on the relay
 *   quality        the JPEG quality Chrome encodes frames at (30–95); a
 *                  stream picks a change up when it next starts (a resize,
 *                  a tab switch)
 *
 * A missing, unreadable or malformed file is the defaults; each field falls
 * back on its own. Read again whenever the file changes, never on a timer.
 */

export interface CastTuning {
  readonly scaleMax: number
  /** The same for a viewer that came through the relay (socket-bridge.ts), whose line is the thinnest. */
  readonly relayScaleMax: number
  readonly quality: number
}

/**
 * 2x: the step from a blurred 1x to sharp text, at about 2.4x a 1x frame's
 * bytes (measured 11-24). The relay stays 1x until its stats say otherwise:
 * it sends at most four frames a second (socket-bridge.ts · SOCKET_BRIDGE_FRAME_MS)
 * down the slowest line there is.
 */
export const CAST_TUNING_DEFAULTS: CastTuning = { scaleMax: 2, relayScaleMax: 1, quality: 60 }

function scaleField(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.round(value * 2) / 2, 1), VIEWPORT_SCALE_MAX)
    : fallback
}
const QUALITY_MIN = 30
const QUALITY_MAX = 95

export function castTuningFile(): string {
  return path.join(homedir(), '.cookrew', 'cast-tuning.json')
}

/** The file's fields, each bounded; anything unusable is its default. */
export function parseCastTuning(raw: unknown): CastTuning {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const quality = obj.quality
  return {
    scaleMax: scaleField(obj.scaleMax, CAST_TUNING_DEFAULTS.scaleMax),
    relayScaleMax: scaleField(obj.relayScaleMax, CAST_TUNING_DEFAULTS.relayScaleMax),
    quality:
      typeof quality === 'number' && Number.isFinite(quality)
        ? Math.min(Math.max(Math.round(quality), QUALITY_MIN), QUALITY_MAX)
        : CAST_TUNING_DEFAULTS.quality
  }
}

let cached: { file: string; mtimeMs: number; tuning: CastTuning } | null = null

/** The tuning now: the file's, re-read only when its modification time moved. */
export function castTuning(file: string = castTuningFile()): CastTuning {
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    cached = null
    return CAST_TUNING_DEFAULTS
  }
  if (cached && cached.file === file && cached.mtimeMs === mtimeMs) return cached.tuning
  let tuning = CAST_TUNING_DEFAULTS
  try {
    tuning = parseCastTuning(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    console.error('The live view tuning file could not be read; using the defaults:', error)
  }
  cached = { file, mtimeMs, tuning }
  return tuning
}
