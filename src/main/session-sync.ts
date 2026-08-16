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

/**
 * Consecutive quiet polls (no byte GROWTH — an mtime touch is not work, and
 * `claude --resume` touches without appending) a RELEASED terminal survives
 * before it drains to a suspended signature. Thirty seconds at the default
 * poll: long enough that a turn's ordinary pauses never drain mid-work,
 * short enough that a quiet background fleet returns to zero cost. Drain is
 * the v5 replacement for a manual tracking flag — there is nothing to
 * forget, so nothing can leak.
 */
export const DRAIN_TICKS = 15

/** Session-file lines → TurnRecords; one per 'file'-capable harness. */
export type SessionTurnParser = (lines: string[]) => TurnRecord[]

export interface SessionTurnSyncHooks {
  /**
   * A poll found the file unchanged. This is the settle confirmation the
   * file-observer dispatch closure needs: a record that was CURRENT on the
   * last growth poll and is still the tail one quiet poll later belongs to
   * a finished turn, not a stream in flight. Fired for every watched
   * terminal; the handler decides whether anything is armed.
   */
  onQuiet?: (terminalId: string) => void
}

interface WatchedFile {
  file: string
  mtimeMs: number
  size: number
  parse: SessionTurnParser
  /** Exact tracker array produced by the last successful reconcile. */
  history: TurnRecord[] | null
  /** Focus left this terminal: drain after DRAIN_TICKS without growth. */
  draining: boolean
  /** Consecutive polls without byte growth, counted only while draining. */
  drainTicks: number
}

export class SessionTurnSync {
  private watched = new Map<string, WatchedFile>()
  /** Last verified signature survives a workspace-switch unwatch/reattach. */
  private dormant = new Map<string, WatchedFile>()
  /** In-flight work (a dispatch) holding a released terminal open. */
  private pinned = new Set<string>()
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
          // Presence pins: a watch() is focus (or a fresh dispatch), so any
          // pending drain is cancelled.
          this.watched.set(terminalId, { ...prior, draining: false, drainTicks: 0 })
          this.turns.setHistorySource(terminalId, 'file')
          this.ensureTimer()
          return
        }
      } catch {
        // Rotated/missing file: fall through to the ordinary scrape-covered
        // reconcile path, which will retry on the next poll.
      }
    }

    this.watched.set(terminalId, {
      file,
      mtimeMs: 0,
      size: 0,
      parse,
      history: null,
      draining: false,
      drainTicks: 0
    })
    // This file has not proven anything yet — a fresh --session-id boot writes
    // nothing for seconds, and a restore rebinds to a file that may not exist.
    // The scrape covers the window; reconcile() hands over if the file is
    // already there and readable.
    this.turns.setHistorySource(terminalId, 'scrape')
    this.reconcile(terminalId)
    this.ensureTimer()
  }

  /**
   * Focus left this terminal's workspace (v5 A4). Do NOT stop watching:
   * work is whatever the session file says it is, and the file growing IS
   * the work. The watch stays live while bytes arrive and drains to a
   * suspended signature after DRAIN_TICKS quiet polls — automatically,
   * with no flag anyone can forget. A pin (in-flight dispatch) holds the
   * watch open through the longest quiet tool call.
   */
  release(terminalId: string): void {
    const watched = this.watched.get(terminalId)
    if (!watched) return
    this.watched.set(terminalId, { ...watched, draining: true, drainTicks: 0 })
  }

  /** In-flight dispatch: this terminal may not drain until unpin(). */
  pin(terminalId: string): void {
    this.pinned.add(terminalId)
  }

  /** Dispatch settled: the ordinary drain clock owns the terminal again. */
  unpin(terminalId: string): void {
    this.pinned.delete(terminalId)
    const watched = this.watched.get(terminalId)
    if (watched && watched.draining) {
      this.watched.set(terminalId, { ...watched, drainTicks: 0 })
    }
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
    this.pinned.delete(terminalId)
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
    this.pinned.clear()
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
   * A poll where a draining terminal's file did not GROW. Measured in bytes,
   * never mtime — `claude --resume` touches the file it opens without
   * appending, and a touch that reset this clock would hold a dead session
   * watched forever. When the window closes and no pin holds the terminal,
   * it drains: suspend, keeping the verified signature so the next watch()
   * costs zero bytes.
   */
  private noteDrainQuiet(terminalId: string, watched: WatchedFile): void {
    if (!watched.draining) return
    const drainTicks = watched.drainTicks + 1
    if (drainTicks < DRAIN_TICKS || this.pinned.has(terminalId)) {
      this.watched.set(terminalId, { ...watched, drainTicks })
      return
    }
    this.suspend(terminalId)
  }

  private reconcile(terminalId: string): void {
    const watched = this.watched.get(terminalId)
    if (!watched) return
    try {
      const stat = statSync(watched.file)
      const bytesMoved = stat.size !== watched.size
      if (stat.mtimeMs === watched.mtimeMs && stat.size === watched.size) {
        // Drain accounting first: the quiet hook may settle a dispatch whose
        // endWork unpins this very entry, and that reset must not be
        // clobbered by a stale copy taken before the callback ran.
        this.noteDrainQuiet(terminalId, watched)
        this.hooks.onQuiet?.(terminalId)
        return
      }
      const records = watched.parse(readFileSync(watched.file, 'utf8').split('\n'))
      this.turns.replaceHistory(terminalId, records)
      this.watched.set(terminalId, {
        ...watched,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        history: this.turns.history(terminalId),
        // A shrink is movement too — a /rewind means the agent is writing.
        drainTicks: bytesMoved ? 0 : watched.drainTicks + 1
      })
      // Read and parsed: the file is real and is now the durable record, so
      // the tracker can stop writing history for this terminal. Deliberately
      // NOT conditional on records.length — a session file that exists but
      // holds no turns yet is still the thing the next turn lands in, and the
      // reconcile that brings it will replace whatever is here anyway.
      this.turns.setHistorySource(terminalId, 'file')
      // A drain can come due on this path too: an mtime that moves while the
      // size stands still is a touch, not work, and must not watch forever.
      const updated = this.watched.get(terminalId)
      if (
        updated?.draining &&
        updated.drainTicks >= DRAIN_TICKS &&
        !this.pinned.has(terminalId)
      ) {
        this.suspend(terminalId)
      }
    } catch {
      // Session file not written yet (fresh --session-id boot) — keep polling,
      // and leave the terminal on the scrape so the turns it takes meanwhile
      // are still recorded.
    }
  }
}
