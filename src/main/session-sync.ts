// Continuous reconcile of TurnRecords against agent session files.
//
// Each watched terminal's session file (Claude's ~/.claude/projects JSONL,
// a Codex rollout, a Pi per-node session — the harness's `parseTurns` picks
// the shape) is polled with a debounced mtime+size check; on change the file
// is re-parsed and the tracker's history REPLACED — appends grow it, /rewind
// truncation shrinks it, so recorded turns always mirror the original
// conversation. The PTY tracker keeps owning the live phase; this owns the
// durable record.
//
// Owning it also means DECLARING it (step 4, checkpoint-as-identity): this is
// the only place that takes a terminal off the tracker's scrape path, and it
// does so from evidence — a reconcile that actually landed — never from the
// harness's declared capability. A terminal is handed back to the scrape the
// moment that evidence lapses: a rebind to a different file, an unwatch, a
// dispose. The rule is that at every instant SOMETHING is recording history.

import { readFileSync, statSync } from 'node:fs'
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
  /** Exact tracker array produced by the last successful reconcile. */
  history: TurnRecord[] | null
}

export class SessionTurnSync {
  private watched = new Map<string, WatchedFile>()
  /** Last verified signature survives a workspace-switch unwatch/reattach. */
  private dormant = new Map<string, WatchedFile>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private turns: TurnTracker,
    private pollMs = DEFAULT_POLL_MS
  ) {}

  /**
   * Start reconciling a terminal against its session file (idempotent).
   *
   * `parse` is REQUIRED and must be the harness's own parser — the one whose
   * indices equal that harness's trace-block indices. It used to default to
   * Claude's, which meant a harness that forgot to wire `parseTurns` silently
   * got a parser for a file format it does not have: zero records, or worse,
   * records in an index space nothing else shares. That is the divergence
   * class this module exists to prevent, so it is now a compile error.
   */
  watch(terminalId: string, file: string, parse: SessionTurnParser): void {
    const prior = this.watched.get(terminalId) ?? this.dormant.get(terminalId)
    this.dormant.delete(terminalId)
    if (prior && prior.file === file && prior.parse === parse && prior.history !== null) {
      try {
        const stat = statSync(file)
        const historyIntact = this.turns.history(terminalId) === prior.history
        if (historyIntact && stat.mtimeMs === prior.mtimeMs && stat.size === prior.size) {
          // Exact same source and bytes as the last successful reconcile. The
          // TurnTracker intentionally retains history across a workspace
          // detach, so reparsing hundreds of MB cannot make it more exact.
          this.watched.set(terminalId, prior)
          this.turns.setHistorySource(terminalId, 'file')
          this.ensureTimer()
          return
        }
      } catch {
        // Rotated/missing file: fall through to the ordinary scrape-covered
        // reconcile path, which will retry on the next poll.
      }
    }

    this.watched.set(terminalId, { file, mtimeMs: 0, size: 0, parse, history: null })
    // This file has not proven anything yet — a fresh --session-id boot writes
    // nothing for seconds, and a restore rebinds to a file that may not exist.
    // The scrape covers the window; reconcile() hands over if the file is
    // already there and readable.
    this.turns.setHistorySource(terminalId, 'scrape')
    this.reconcile(terminalId)
    this.ensureTimer()
  }

  /** Workspace switch only: retain a verified signature for exact reattach. */
  suspend(terminalId: string): void {
    const watched = this.watched.get(terminalId)
    if (watched) this.dormant.set(terminalId, watched)
    this.stopWatching(terminalId)
  }

  /** Permanent/rebind release: no dormant context may survive it. */
  unwatch(terminalId: string): void {
    this.dormant.delete(terminalId)
    this.stopWatching(terminalId)
  }

  private stopWatching(terminalId: string): void {
    this.watched.delete(terminalId)
    this.turns.setHistorySource(terminalId, 'scrape')
    if (this.watched.size === 0 && this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    // Nothing is reconciling any more, so nothing may stay off the scrape.
    for (const terminalId of this.watched.keys()) {
      this.turns.setHistorySource(terminalId, 'scrape')
    }
    this.watched.clear()
    this.dormant.clear()
  }

  private ensureTimer(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.tick(), this.pollMs)
    this.timer.unref?.()
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
      const records = watched.parse(readFileSync(watched.file, 'utf8').split('\n'))
      this.turns.replaceHistory(terminalId, records)
      this.watched.set(terminalId, {
        ...watched,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        history: this.turns.history(terminalId)
      })
      // Read and parsed: the file is real and is now the durable record, so
      // the tracker can stop writing history for this terminal. Deliberately
      // NOT conditional on records.length — a session file that exists but
      // holds no turns yet is still the thing the next turn lands in, and the
      // reconcile that brings it will replace whatever is here anyway.
      this.turns.setHistorySource(terminalId, 'file')
    } catch {
      // Session file not written yet (fresh --session-id boot) — keep polling,
      // and leave the terminal on the scrape so the turns it takes meanwhile
      // are still recorded.
    }
  }
}
