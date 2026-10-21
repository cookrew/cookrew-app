// WHEN EACH DESKTOP'S RELAY LINE WAS LAST SEEN, kept across a registry restart
// (strata · FleetMachine.lastSeenAt).
//
// The relay sees a line open, beat and close in memory; without this file a
// restart forgot all of it until each desktop next filed its record. One small
// JSON beside the other stores, written at most once per SEEN_FLUSH_MS however
// many lines beat, and atomically (temp file, then rename). A crash loses at
// most that window of beats; a line's open or close is not worth more.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** How often the file may be rewritten. */
export const SEEN_FLUSH_MS = 30_000
/** A line not seen for this long is forgotten at load: its desktop is gone or long asleep, and the record PUT time stands in. */
export const SEEN_KEEP_MS = 90 * 24 * 60 * 60 * 1000
/** Bound on names kept, against a file that grows without one. */
export const SEEN_MAX = 50_000

export interface LineSeen {
  get(name: string): number | undefined
  see(name: string): void
  /** Write now if anything changed (tests, shutdown). */
  flush(): void
}

export function createLineSeen(file: string | null, now: () => number = Date.now, flushMs = SEEN_FLUSH_MS): LineSeen {
  const seen = new Map<string, number>()
  if (file !== null) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const cutoff = now() - SEEN_KEEP_MS
      for (const [name, at] of Object.entries(raw)) {
        if (typeof at === 'number' && Number.isFinite(at) && at >= cutoff && seen.size < SEEN_MAX) seen.set(name, at)
      }
    } catch {
      // No file yet, or a torn one: start from nothing; the record PUT time stands in.
    }
  }
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!dirty || file === null) return
    dirty = false
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(Object.fromEntries(seen)))
      renameSync(temporary, file)
    } catch (error) {
      console.error(`line-seen: could not write ${file}:`, error)
    }
  }

  return {
    get: (name) => seen.get(name),
    see: (name) => {
      if (!seen.has(name) && seen.size >= SEEN_MAX) return
      seen.set(name, now())
      dirty = true
      if (file !== null && timer === null) {
        timer = setTimeout(flush, flushMs)
        timer.unref?.()
      }
    },
    flush
  }
}
