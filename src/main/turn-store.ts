// Disk persistence for per-terminal turn history, so the card pager and
// fork-from-turn survive app restarts (terminal ids are stable across runs —
// they live in workspace.json and their tmux sessions persist too).
//
// ONE LINE PER RECORD under ~/.cookrew/turns/<terminalId>.jsonl. History is
// not capped, which is only affordable because the common case — a turn
// finished, nothing else changed — appends a single line instead of rewriting
// the file. The previous format was one pretty-printed JSON array rewritten in
// full on every turn: O(n) per turn and O(n²) over a session, which is the
// reason a cap existed at all.
//
// Writes are debounced per terminal; TurnTracker flushes on app quit.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { TurnRecord } from '../shared/turn'

const SAVE_DEBOUNCE_MS = 300

/** Shape check for records read back from disk (files are user-editable). */
function isTurnRecord(value: unknown): value is TurnRecord {
  const r = value as TurnRecord
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.index === 'number' &&
    typeof r.prompt === 'string' &&
    typeof r.reply === 'string' &&
    typeof r.startedAt === 'number' &&
    typeof r.endedAt === 'number'
  )
}

/** What the last flush left on disk, so the next one can tell append from edit. */
interface Written {
  count: number
  /** Serialized form of the final record — an edit to it forces a rewrite. */
  lastLine: string
}

export class TurnStore {
  private timers = new Map<string, NodeJS.Timeout>()
  private pending = new Map<string, TurnRecord[]>()
  private written = new Map<string, Written>()
  /**
   * Whole-ledger cache for loadAll(). Built once and kept warm by write-through
   * from flush()/remove() — this process is the only writer, so re-reading every
   * file per board or search request would be pure waste on the request path.
   * The map handed back is the LIVE cache: read only.
   */
  private all: Map<string, TurnRecord[]> | null = null

  constructor(private dir = path.join(homedir(), '.cookrew', 'turns')) {}

  private safeId(terminalId: string): string {
    return terminalId.replace(/[^a-zA-Z0-9_-]/g, '')
  }

  private fileFor(terminalId: string): string {
    return path.join(this.dir, `${this.safeId(terminalId)}.jsonl`)
  }

  /** Pre-JSONL format: one pretty-printed array per terminal. */
  private legacyFileFor(terminalId: string): string {
    return path.join(this.dir, `${this.safeId(terminalId)}.json`)
  }

  /**
   * Read the lines file, dropping any line that will not parse. A single
   * corrupt line must not blank an agent's whole history.
   */
  private readLines(file: string): TurnRecord[] {
    const records: TurnRecord[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isTurnRecord(parsed)) records.push(parsed)
      } catch {
        // one bad line, not the file
      }
    }
    return records
  }

  /**
   * Convert a legacy array file to lines, once, on first touch. Returns the
   * records so the caller does not pay for a second read.
   */
  private migrate(terminalId: string): TurnRecord[] | null {
    const legacy = this.legacyFileFor(terminalId)
    if (!existsSync(legacy)) return null
    try {
      const parsed: unknown = JSON.parse(readFileSync(legacy, 'utf8'))
      const records = Array.isArray(parsed) ? parsed.filter(isTurnRecord) : []
      this.writeAll(terminalId, records)
      // Keep the original as .migrated rather than deleting it — this is the
      // only copy of history that predates the lines format.
      renameSync(legacy, `${legacy}.migrated`)
      return records
    } catch (error) {
      console.error('Failed to migrate turn history:', error)
      return null
    }
  }

  load(terminalId: string): TurnRecord[] {
    const pending = this.pending.get(terminalId)
    if (pending) return pending
    try {
      const file = this.fileFor(terminalId)
      if (existsSync(file)) return this.readLines(file)
      return this.migrate(terminalId) ?? []
    } catch (error) {
      console.error('Failed to load turn history:', error)
      return []
    }
  }

  /**
   * How many checkpoints this agent has, WITHOUT parsing any of them. This is
   * what makes an uncapped history affordable to display: the count is exact
   * even when only a tail is held in memory.
   */
  count(terminalId: string): number {
    const pending = this.pending.get(terminalId)
    if (pending) return pending.length
    try {
      const file = this.fileFor(terminalId)
      if (!existsSync(file)) return this.migrate(terminalId)?.length ?? 0
      let lines = 0
      const text = readFileSync(file, 'utf8')
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
      // A trailing newline is written after every record, so lines === records
      // unless the file ends mid-write.
      return text.endsWith('\n') ? lines : lines + 1
    } catch {
      return 0
    }
  }

  /**
   * The newest `n` checkpoints. Cards and the rail open on the recent end, so
   * attaching to a 5,000-turn agent parses 200 records rather than all of them;
   * older windows are fetched on demand.
   */
  loadTail(terminalId: string, n: number): TurnRecord[] {
    const all = this.load(terminalId)
    return n >= all.length ? all : all.slice(all.length - n)
  }

  /**
   * Every agent's checkpoints, across every workspace — the board's L3 ledger
   * layer and the corpus checkpoint search runs over. Terminals with no usable
   * records are omitted, pending writes are layered on so a search never misses
   * the turn that just finished, and one unreadable file is isolated rather
   * than aborting the walk.
   */
  loadAll(): Map<string, TurnRecord[]> {
    if (this.all) return this.withPending(this.all)
    const all = new Map<string, TurnRecord[]>()
    try {
      if (existsSync(this.dir)) {
        for (const name of readdirSync(this.dir)) {
          const isLines = name.endsWith('.jsonl')
          const isLegacy = name.endsWith('.json')
          if (!isLines && !isLegacy) continue
          const terminalId = name.slice(0, name.lastIndexOf('.'))
          if (isLegacy && existsSync(this.fileFor(terminalId))) continue
          try {
            const records = isLines
              ? this.readLines(path.join(this.dir, name))
              : this.load(terminalId)
            // Terminals with no usable records are OMITTED — the board's L3
            // layer relies on never having to filter empties itself.
            if (records.length > 0) all.set(terminalId, records)
          } catch {
            // one corrupt file, not the whole ledger
          }
        }
      }
    } catch (error) {
      console.error('Failed to walk the turn ledger:', error)
    }
    this.all = all
    return this.withPending(all)
  }

  /**
   * Layer debounced writes over a snapshot, so a search never misses the turn
   * that just finished — without baking them into the cache, which must stay a
   * faithful picture of what is actually on disk.
   */
  private withPending(base: Map<string, TurnRecord[]>): Map<string, TurnRecord[]> {
    if (this.pending.size === 0) return base
    const warm = new Map(base)
    for (const [terminalId, records] of this.pending) warm.set(this.safeId(terminalId), records)
    return warm
  }

  scheduleSave(terminalId: string, records: TurnRecord[]): void {
    this.pending.set(terminalId, records)
    if (this.timers.has(terminalId)) return
    this.timers.set(
      terminalId,
      setTimeout(() => this.flush(terminalId), SAVE_DEBOUNCE_MS),
    )
  }

  private line(record: TurnRecord): string {
    return JSON.stringify(record)
  }

  private writeAll(terminalId: string, records: TurnRecord[]): void {
    mkdirSync(this.dir, { recursive: true })
    const body = records.map((r) => `${this.line(r)}\n`).join('')
    writeFileSync(this.fileFor(terminalId), body, 'utf8')
    this.remember(terminalId, records)
    this.cache(terminalId, records)
  }

  /**
   * Keep loadAll()'s cache current rather than invalidating it, which would
   * force a full re-read of the ledger on the next request.
   */
  private cache(terminalId: string, records: TurnRecord[]): void {
    if (!this.all) return
    const key = this.safeId(terminalId)
    if (records.length > 0) this.all.set(key, records)
    else this.all.delete(key)
  }

  private remember(terminalId: string, records: TurnRecord[]): void {
    this.written.set(terminalId, {
      count: records.length,
      lastLine: records.length > 0 ? this.line(records[records.length - 1]) : '',
    })
  }

  /**
   * Append when the history only GREW and its previous last record is
   * byte-identical to what we wrote; otherwise rewrite.
   *
   * The conservative half matters: seenAt stamps, Sous titles landing late and
   * phantom-echo dedupe all EDIT existing records, and an append would silently
   * drop those. Anything the fast path cannot prove is an append falls back to
   * a full rewrite, so the worst case is exactly the old behaviour.
   */
  private flush(terminalId: string): void {
    const timer = this.timers.get(terminalId)
    if (timer) clearTimeout(timer)
    this.timers.delete(terminalId)
    const records = this.pending.get(terminalId)
    this.pending.delete(terminalId)
    if (!records) return

    try {
      const known = this.written.get(terminalId)
      const file = this.fileFor(terminalId)
      const canAppend =
        known !== undefined &&
        known.count > 0 &&
        records.length > known.count &&
        existsSync(file) &&
        this.line(records[known.count - 1]) === known.lastLine

      if (canAppend) {
        const added = records.slice(known.count).map((r) => `${this.line(r)}\n`)
        appendFileSync(file, added.join(''), 'utf8')
        this.remember(terminalId, records)
        this.cache(terminalId, records)
        return
      }
      this.writeAll(terminalId, records)
    } catch (error) {
      console.error('Failed to save turn history:', error)
    }
  }

  /** Drop a removed terminal's history file (node deletion). */
  remove(terminalId: string): void {
    const timer = this.timers.get(terminalId)
    if (timer) clearTimeout(timer)
    this.timers.delete(terminalId)
    this.pending.delete(terminalId)
    this.written.delete(terminalId)
    this.all?.delete(this.safeId(terminalId))
    try {
      for (const file of [this.fileFor(terminalId), this.legacyFileFor(terminalId)]) {
        if (existsSync(file)) unlinkSync(file)
      }
    } catch (error) {
      console.error('Failed to remove turn history:', error)
    }
  }

  /** Bytes on disk for one agent — diagnostics for an uncapped history. */
  sizeOf(terminalId: string): number {
    try {
      const file = this.fileFor(terminalId)
      return existsSync(file) ? statSync(file).size : 0
    } catch {
      return 0
    }
  }

  /** Write out every debounced save now (app quit). */
  flushAll(): void {
    for (const terminalId of [...this.timers.keys()]) this.flush(terminalId)
  }
}
