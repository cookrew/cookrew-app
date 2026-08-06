// Disk persistence for per-terminal turn history, so the card pager and
// fork-from-turn survive app restarts (terminal ids are stable across runs —
// they live in workspace.json and their tmux sessions persist too).
//
// One JSON file per terminal under ~/.cookrew/turns/<terminalId>.json.
// Writes are debounced per terminal; TurnTracker flushes on app quit.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
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

export class TurnStore {
  private timers = new Map<string, NodeJS.Timeout>()
  private pending = new Map<string, TurnRecord[]>()
  /**
   * Whole-ledger cache for loadAll(). Built once (~129 files / 3.7 MB here)
   * and then kept warm by write-through from flush()/remove() — this process
   * is the only writer, so a full re-read per board request would be pure
   * waste on the request path.
   */
  private all: Map<string, TurnRecord[]> | null = null

  constructor(private dir = path.join(homedir(), '.cookrew', 'turns')) {}

  /** Filename stem == the sanitized terminal id; also the loadAll() key. */
  private keyFor(terminalId: string): string {
    return terminalId.replace(/[^a-zA-Z0-9_-]/g, '')
  }

  private fileFor(terminalId: string): string {
    return path.join(this.dir, `${this.keyFor(terminalId)}.json`)
  }

  private parse(file: string): TurnRecord[] {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(isTurnRecord) : []
  }

  /**
   * Every terminal's persisted history — the board's L3 ledger layer.
   * Terminals with no usable records are omitted, so the caller never has to
   * filter empties. The returned map is the live cache: READ ONLY.
   */
  loadAll(): Map<string, TurnRecord[]> {
    if (this.all) return this.all
    const all = new Map<string, TurnRecord[]>()
    try {
      if (existsSync(this.dir)) {
        for (const name of readdirSync(this.dir)) {
          if (!name.endsWith('.json')) continue
          try {
            const records = this.parse(path.join(this.dir, name))
            if (records.length > 0) all.set(path.basename(name, '.json'), records)
          } catch {
            // One corrupt file must not blank the whole board.
          }
        }
      }
    } catch (error) {
      console.error('Failed to load turn ledger:', error)
    }
    this.all = all
    return all
  }

  load(terminalId: string): TurnRecord[] {
    try {
      const file = this.fileFor(terminalId)
      if (!existsSync(file)) return []
      return this.parse(file)
    } catch (error) {
      console.error('Failed to load turn history:', error)
      return []
    }
  }

  scheduleSave(terminalId: string, records: TurnRecord[]): void {
    this.pending.set(terminalId, records)
    if (this.timers.has(terminalId)) return
    this.timers.set(
      terminalId,
      setTimeout(() => this.flush(terminalId), SAVE_DEBOUNCE_MS)
    )
  }

  private flush(terminalId: string): void {
    const timer = this.timers.get(terminalId)
    if (timer) clearTimeout(timer)
    this.timers.delete(terminalId)
    const records = this.pending.get(terminalId)
    this.pending.delete(terminalId)
    if (!records) return
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.fileFor(terminalId), JSON.stringify(records, null, 2), 'utf8')
      // Incremental refresh: keep loadAll()'s cache current instead of
      // invalidating it (which would force a 129-file re-read next request).
      if (this.all) {
        if (records.length > 0) this.all.set(this.keyFor(terminalId), records)
        else this.all.delete(this.keyFor(terminalId))
      }
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
    try {
      const file = this.fileFor(terminalId)
      if (existsSync(file)) unlinkSync(file)
      this.all?.delete(this.keyFor(terminalId))
    } catch (error) {
      console.error('Failed to remove turn history:', error)
    }
  }

  /** Write out every debounced save now (app quit). */
  flushAll(): void {
    for (const terminalId of [...this.timers.keys()]) this.flush(terminalId)
  }
}
