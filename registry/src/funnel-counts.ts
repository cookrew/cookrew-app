import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  FUNNEL_EVENTS,
  dayOf,
  isFunnelDay,
  isFunnelEvent,
  isFunnelVersion,
  isOsFamily,
  type FunnelEvent,
  type FunnelPayload,
  type OsFamily
} from '../../src/shared/funnel-events'

/**
 * THE FUNNEL'S COUNTS — daily sums, and nothing that could name an install.
 *
 * One number per day per (event, OS family, version). The install id is
 * validated on the way in and dropped here, so the file cannot say which
 * installs got how far, and no address is held at all: the limiter in front of
 * this works on a keyed digest (`funnelLimiterKey`) whose key dies with the
 * process. Same shape as pulse.ts, kept apart because a pulse lasts thirty days
 * and a funnel is read across releases.
 */

const KEEP_DAYS = 400
/** Distinct cells a day may hold. A stranger cannot grow the file by inventing versions. */
const MAX_CELLS = 500
const FLUSH_MS = 10_000
const DAY_MS = 86_400_000
/** How far back a queued event may land: bounds what a client's clock can write. */
const ACCEPT_DAYS_BACK = 30

type Day = Readonly<Record<string, number>>

export interface FunnelRow {
  readonly day: string
  readonly event: FunnelEvent
  readonly osFamily: OsFamily
  readonly appVersion: string
  readonly count: number
}

export interface FunnelTotals {
  readonly totals: Readonly<Record<FunnelEvent, number>>
  readonly days: readonly FunnelRow[]
}

const cellOf = (payload: FunnelPayload): string => `${payload.event}|${payload.osFamily}|${payload.appVersion}`

const readCell = (cell: string): Omit<FunnelRow, 'day' | 'count'> | null => {
  const [event, osFamily, appVersion, ...rest] = cell.split('|')
  if (rest.length > 0 || !isFunnelEvent(event) || !isOsFamily(osFamily) || !isFunnelVersion(appVersion)) return null
  return { event, osFamily, appVersion }
}

const readDay = (value: unknown): Day => {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      ([cell, count]) => readCell(cell) !== null && typeof count === 'number' && Number.isInteger(count) && count > 0
    )
  )
}

export class FunnelCounts {
  private readonly file: string
  private days = new Map<string, Day>()
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> | null = null

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(dataDir, 'funnel.json')
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [day, value] of Object.entries(parsed)) {
          if (isFunnelDay(day)) this.days.set(day, readDay(value))
        }
      }
    } catch {
      // No file is the ordinary case, and a torn one is a count lost.
    }
  }

  /** A client's day is believed only near the server's own. */
  acceptsDay(day: string): boolean {
    const at = this.now()
    return day >= dayOf(at - ACCEPT_DAYS_BACK * DAY_MS) && day <= dayOf(at + DAY_MS)
  }

  add(payload: FunnelPayload): void {
    const day = this.days.get(payload.day) ?? {}
    const cell = cellOf(payload)
    if (!(cell in day) && Object.keys(day).length >= MAX_CELLS) return
    this.days.set(payload.day, { ...day, [cell]: (day[cell] ?? 0) + 1 })
    this.schedule()
  }

  totals(): FunnelTotals {
    const days = [...this.days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([day, cells]) =>
        Object.entries(cells).flatMap(([cell, count]) => {
          const read = readCell(cell)
          return read === null ? [] : [{ day, ...read, count }]
        })
      )
    const zero = Object.fromEntries(FUNNEL_EVENTS.map((event) => [event, 0])) as Record<FunnelEvent, number>
    const totals = days.reduce((sums, row) => ({ ...sums, [row.event]: sums[row.event] + row.count }), zero)
    return { totals, days }
  }

  private schedule(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, FLUSH_MS)
    this.flushTimer.unref?.()
  }

  /** Written whole and renamed, one write in flight at a time. */
  flush(): Promise<void> {
    if (!this.dirty) return this.writing ?? Promise.resolve()
    if (this.writing) return this.writing.then(() => this.flush())
    this.dirty = false
    const cutoff = dayOf(this.now() - KEEP_DAYS * DAY_MS)
    this.days = new Map([...this.days].filter(([day]) => day >= cutoff))
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

const LIMITER_KEY = randomBytes(32)

/**
 * What the limiter holds instead of an address: a keyed digest, with a key that
 * exists only in this process. Rate limiting needs "same caller as a moment
 * ago"; it has no need to be able to say who.
 */
export const funnelLimiterKey = (address: string): string =>
  createHmac('sha256', LIMITER_KEY).update(address).digest('base64url')
