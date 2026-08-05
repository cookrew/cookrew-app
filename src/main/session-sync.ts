// Continuous reconcile of TurnRecords against agent session files.
//
// Each watched terminal's session file (Claude's ~/.claude/projects JSONL,
// a Codex rollout, a Pi per-node session — the harness's `parseTurns` picks
// the shape) is polled with a debounced mtime+size check; on change the file
// is re-parsed and the tracker's history REPLACED — appends grow it, /rewind
// truncation shrinks it, so recorded turns always mirror the original
// conversation. The PTY tracker keeps owning the live phase; this owns the
// durable record.

import { readFileSync, statSync } from 'node:fs'
import { parseSessionTurns } from '../shared/session-turns'
import type { TurnRecord } from '../shared/turn'
import type { TurnTracker } from './turn-tracker'

const DEFAULT_POLL_MS = 2000

/** Session-file lines → TurnRecords; one per 'file'-capable harness. */
export type SessionTurnParser = (lines: string[]) => TurnRecord[]

interface WatchedFile {
  file: string
  mtimeMs: number
  size: number
  parse: SessionTurnParser
}

export class SessionTurnSync {
  private watched = new Map<string, WatchedFile>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private turns: TurnTracker,
    private pollMs = DEFAULT_POLL_MS
  ) {}

  /** Start reconciling a terminal against its session file (idempotent).
   *  `parse` is the harness's session-turn parser (defaults to Claude's). */
  watch(terminalId: string, file: string, parse: SessionTurnParser = parseSessionTurns): void {
    this.watched.set(terminalId, { file, mtimeMs: 0, size: 0, parse })
    this.reconcile(terminalId)
    if (this.timer === null) {
      this.timer = setInterval(() => this.tick(), this.pollMs)
      this.timer.unref?.()
    }
  }

  unwatch(terminalId: string): void {
    this.watched.delete(terminalId)
    if (this.watched.size === 0 && this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.watched.clear()
  }

  private tick(): void {
    for (const terminalId of [...this.watched.keys()]) this.reconcile(terminalId)
  }

  private reconcile(terminalId: string): void {
    const watched = this.watched.get(terminalId)
    if (!watched) return
    try {
      const stat = statSync(watched.file)
      if (stat.mtimeMs === watched.mtimeMs && stat.size === watched.size) return
      this.watched.set(terminalId, { ...watched, mtimeMs: stat.mtimeMs, size: stat.size })
      const records = watched.parse(readFileSync(watched.file, 'utf8').split('\n'))
      this.turns.replaceHistory(terminalId, records)
    } catch {
      // Session file not written yet (fresh --session-id boot) — keep polling.
    }
  }
}
