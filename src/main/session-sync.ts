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
import type { WorkspaceServiceState } from '../shared/model'
import type { TurnRecord } from '../shared/turn'
import type { TurnTracker } from './turn-tracker'

const DEFAULT_POLL_MS = 2000

/**
 * Consecutive polls a watched file may go without GROWING, while its pane is
 * mid-turn, before the sync reports it as stale. Ten ticks is ~20s at the
 * default poll — far below the minutes a rotation's compaction takes, and far
 * above the pauses inside an ordinary turn (which cost nothing anyway: a
 * stale report that finds no successor changes nothing).
 */
export const STALE_TICKS = 10

/** Session-file lines → TurnRecords; one per 'file'-capable harness. */
export type SessionTurnParser = (lines: string[]) => TurnRecord[]

/**
 * Liveness hooks. The sync can see that a file stopped growing; it cannot see
 * whether the agent is working (that is the turn tracker's knowledge) nor what
 * to do about it (that is the rebind, which owns the store). Both are handed
 * in so this module keeps doing exactly one thing.
 */
export interface SessionTurnSyncHooks {
  /** Is the terminal's pane mid-turn? Without it, nothing is ever reported. */
  isInTurn?: (terminalId: string) => boolean
  /**
   * A bound session file went quiet while its pane kept working — it may have
   * rotated out from under us. The handler is free to rebind (and to call
   * watch() with a new file), or to do nothing.
   */
  onStale?: (terminalId: string) => void
}

/**
 * Focus owns the live reconciliation view even when dispatch is disabled.
 * Only a detached dormant lane, or any parked lane, may suspend its file
 * watcher. Keeping this decision pure makes the focused-dormant hole testable.
 */
export function shouldSuspendSessionSync(
  focused: boolean,
  serviceState: WorkspaceServiceState
): boolean {
  return serviceState === 'parked' || !focused
}

interface WatchedFile {
  file: string
  mtimeMs: number
  size: number
  parse: SessionTurnParser
  /** Exact tracker array produced by the last successful reconcile. */
  history: TurnRecord[] | null
  /** Consecutive polls this file has not GROWN by (see noteQuiet). */
  quietTicks: number
}

export class SessionTurnSync {
  private watched = new Map<string, WatchedFile>()
  /** Last verified signature survives a workspace-switch unwatch/reattach. */
  private dormant = new Map<string, WatchedFile>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private turns: TurnTracker,
    private pollMs = DEFAULT_POLL_MS,
    private hooks: SessionTurnSyncHooks = {}
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
          // Quiet ticks do NOT carry over: the file was unobserved while
          // detached, so it has not been seen to go quiet for any of them.
          this.watched.set(terminalId, { ...prior, quietTicks: 0 })
          this.turns.setHistorySource(terminalId, 'file')
          this.ensureTimer()
          return
        }
      } catch {
        // Rotated/missing file: fall through to the ordinary scrape-covered
        // reconcile path, which will retry on the next poll.
      }
    }

    this.watched.set(terminalId, { file, mtimeMs: 0, size: 0, parse, history: null, quietTicks: 0 })
    // This file has not proven anything yet — a fresh --session-id boot writes
    // nothing for seconds, and a restore rebinds to a file that may not exist.
    // The scrape covers the window; reconcile() hands over if the file is
    // already there and readable.
    this.turns.setHistorySource(terminalId, 'scrape')
    this.reconcile(terminalId)
    this.ensureTimer()
  }

  /**
   * Workspace detach: HOT service keeps reconciling without a PTY attachment;
   * dormant/parked service retains a verified signature for exact reattach.
   * The default preserves every pre-service-state caller's old behaviour.
   */
  suspend(terminalId: string, serviceState: WorkspaceServiceState = 'dormant'): void {
    if (serviceState === 'hot') return
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

  /**
   * A poll where the file did not GROW.
   *
   * Measured in BYTES, never in mtime: `claude --resume <id>` touches the
   * file it opens without appending, so an mtime that moves while the size
   * stands still is precisely what a DEAD session looks like — counting
   * mtime would reset the very signal we are trying to accumulate.
   *
   * Reports at most once per stale window (the counter resets on report), so
   * a pane parked inside a ten-minute tool call costs one probe per window
   * and nothing else.
   */
  private noteQuiet(terminalId: string, watched: WatchedFile): void {
    // A file that has never reconciled has nothing to go stale ABOUT — it is
    // a fresh --session-id boot that has not been written yet.
    if (watched.history === null) return
    const quietTicks = watched.quietTicks + 1
    if (quietTicks < STALE_TICKS || !this.hooks.isInTurn?.(terminalId)) {
      this.watched.set(terminalId, { ...watched, quietTicks })
      return
    }
    // Reset BEFORE the report: the handler may rebind this terminal onto a
    // different file, and that entry must not be clobbered afterwards.
    this.watched.set(terminalId, { ...watched, quietTicks: 0 })
    this.hooks.onStale?.(terminalId)
  }

  private reconcile(terminalId: string): void {
    const watched = this.watched.get(terminalId)
    if (!watched) return
    try {
      const stat = statSync(watched.file)
      const bytesMoved = stat.size !== watched.size
      if (!bytesMoved) this.noteQuiet(terminalId, watched)
      // noteQuiet may have handed this terminal to a REBIND, which watches a
      // different file; reconciling the dead one now would undo it. It also
      // rewrites the entry's quiet count, so the fresh entry is the base for
      // everything below — never the stale closure.
      const base = this.watched.get(terminalId)
      if (!base || base.file !== watched.file) return
      if (!bytesMoved && stat.mtimeMs === watched.mtimeMs) return
      const records = watched.parse(readFileSync(watched.file, 'utf8').split('\n'))
      this.turns.replaceHistory(terminalId, records)
      this.watched.set(terminalId, {
        ...base,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        // A file whose bytes did not move is still quiet, however much its
        // mtime jumped — the count has to survive the reparse that follows.
        // A /rewind SHRINK counts as movement: the agent is writing.
        quietTicks: bytesMoved ? 0 : base.quietTicks,
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
