import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
    const entry = today.doors[name] ?? { lines: 0, calls: 0 }
    today.doors[name] = { lines: entry.lines + (kind === 'line' ? 1 : 0), calls: entry.calls + 1 }
    this.schedule()
  }

  page(pathname: string): void {
    const today = this.today()
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

  pagesToday(): Record<string, number> {
    return { ...this.today().pages }
  }

  private today(): Day {
    const key = new Date(this.now()).toISOString().slice(0, 10)
    const existing = this.days.get(key)
    if (existing) return existing
    const fresh: Day = { doors: {}, pages: {} }
    this.days.set(key, fresh)
    return fresh
  }

  /** Counts arrive on every request; the file is written at most once a second. */
  private schedule(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, 1000)
    this.flushTimer.unref?.()
  }

  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    const cutoff = new Date(this.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)
    for (const day of [...this.days.keys()]) if (day < cutoff) this.days.delete(day)
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.days)), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch {
      // A count that could not be written is a count lost, never a request failed.
    }
  }
}
