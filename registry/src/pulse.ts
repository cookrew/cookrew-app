import { mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * THE PULSE — what happened on cookrew.dev today, counted, never who.
 *
 * Two kinds of count, both per UTC day:
 *
 *   door   lines opened at a served team (a caller's GET /line through the
 *          relay) and calls carried to it. The homepage's live board shows
 *          these, so "serving right now" is a number that moves, not a badge.
 *   page   views of a path. Rendered nowhere public; it is the site's own
 *          measurement, kept here because the registry is the one place that
 *          sees every request and no third-party script ever will.
 *
 * No identity is recorded — not the caller, not a cookie, not an address.
 * Thirty days are kept; older days are dropped on write.
 */

const KEEP_DAYS = 30
/** Distinct keys a day may hold, per kind. A stranger cannot grow the file by inventing names. */
const MAX_KEYS = 500
const FLUSH_MS = 10_000

interface Day {
  doors: Record<string, { lines: number; calls: number }>
  pages: Record<string, number>
}

export interface DoorPulse {
  /** Lines opened today: sessions started or resumed at this door. */
  lines: number
  /** Everything carried to the door today, lines included. */
  calls: number
}

export class Pulse {
  private readonly file: string
  private days = new Map<string, Day>()
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(dataDir, 'pulse.json')
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [day, value] of Object.entries(parsed as Record<string, Day>)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(day)) this.days.set(day, { doors: value.doors ?? {}, pages: value.pages ?? {} })
        }
      }
    } catch {
      // No file is the ordinary case for a fresh registry.
    }
  }

  /** A call carried to a door; a line is the one that opens the caller's terminal. */
  door(name: string, kind: 'line' | 'call'): void {
    const today = this.today()
    if (!(name in today.doors) && Object.keys(today.doors).length >= MAX_KEYS) return
    const entry = today.doors[name] ?? { lines: 0, calls: 0 }
    today.doors[name] = { lines: entry.lines + (kind === 'line' ? 1 : 0), calls: entry.calls + 1 }
    this.schedule()
  }

  /** Only paths the router resolved are counted — never a raw request line. */
  page(pathname: string): void {
    const today = this.today()
    if (!(pathname in today.pages) && Object.keys(today.pages).length >= MAX_KEYS) return
    today.pages[pathname] = (today.pages[pathname] ?? 0) + 1
    this.schedule()
  }

  doorToday(name: string): DoorPulse {
    return this.today().doors[name] ?? { lines: 0, calls: 0 }
  }

  /** Every door's lines today, summed — the site-wide number. */
  linesToday(): number {
    return Object.values(this.today().doors).reduce((n, d) => n + d.lines, 0)
  }

  private today(): Day {
    const key = new Date(this.now()).toISOString().slice(0, 10)
    const existing = this.days.get(key)
    if (existing) return existing
    const fresh: Day = { doors: {}, pages: {} }
    this.days.set(key, fresh)
    return fresh
  }

  /** Counts arrive on every request; the file is written at most every ten seconds, off the loop. */
  private schedule(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, FLUSH_MS)
    this.flushTimer.unref?.()
  }

  private writing: Promise<void> | null = null

  /** Written whole and renamed, asynchronously, one write in flight at a time. */
  flush(): Promise<void> {
    if (!this.dirty) return this.writing ?? Promise.resolve()
    if (this.writing) return this.writing.then(() => this.flush())
    this.dirty = false
    const cutoff = new Date(this.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)
    for (const day of [...this.days.keys()]) if (day < cutoff) this.days.delete(day)
    const snapshot = JSON.stringify(Object.fromEntries(this.days))
    const tmp = `${this.file}.${process.pid}.tmp`
    this.writing = (async () => {
      try {
        mkdirSync(path.dirname(this.file), { recursive: true })
        await writeFile(tmp, snapshot, { mode: 0o600 })
        await rename(tmp, this.file)
      } catch {
        // A count that could not be written is a count lost, never a request failed.
      } finally {
        this.writing = null
      }
    })()
    return this.writing
  }
}
