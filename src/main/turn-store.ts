// Disk persistence for per-terminal turn history, so the card pager and
// fork-from-turn survive app restarts (terminal ids are stable across runs —
// they live in workspace.json and their tmux sessions persist too).
//
// One JSON file per terminal under ~/.cookrew/turns/<terminalId>.json.
// Writes are debounced per terminal; TurnTracker flushes on app quit.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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

  constructor(private dir = path.join(homedir(), '.cookrew', 'turns')) {}

  private fileFor(terminalId: string): string {
    return path.join(this.dir, `${terminalId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
  }

  load(terminalId: string): TurnRecord[] {
    try {
      const file = this.fileFor(terminalId)
      if (!existsSync(file)) return []
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter(isTurnRecord) : []
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
    } catch (error) {
      console.error('Failed to remove turn history:', error)
    }
  }

  /** Write out every debounced save now (app quit). */
  flushAll(): void {
    for (const terminalId of [...this.timers.keys()]) this.flush(terminalId)
  }
}
