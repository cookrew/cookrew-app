// Continuous reconcile of TurnRecords against agent session files.
//
// Each watched terminal's session file (Claude's ~/.claude/projects JSONL,
// a Codex rollout, a Pi per-node session — the harness's `parseTurns` picks
// the shape) is polled with a debounced mtime+size check; on growth ONLY the
// appended bytes are read and fed to a resumable accumulator, so a live
// fleet's poll cost is O(Δbytes), never O(file). A shrink, a same-size
// rewrite, or a dev/ino change (rotation) resets the accumulator and pays
// one full re-parse — that is the rewind/rotation path and is allowed to be
// O(S). The PTY tracker keeps owning the live phase; this owns the durable
// record.
//
// Owning it also means DECLARING it (step 4, checkpoint-as-identity): this is
// the only place that takes a terminal off the tracker's scrape path, and it
// does so from evidence — a reconcile that actually landed — never from the
// harness's declared capability. A terminal is handed back to the scrape the
// moment that evidence lapses: a rebind to a different file, an unwatch, a
// dispose. The rule is that at every instant SOMETHING is recording history.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import {
  type SessionTurnAccumulator,
  type StreamingTurnParser
} from '../shared/session-turns'
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

/**
 * Consecutive polls without byte growth after which a terminal that CLAIMS
 * to be mid-turn (hooks.isInTurn) is reported stale: the bound file is not
 * receiving the work, which is the rotated-session signature (`claude
 * --resume` under the same pane writes a NEW file). Shorter than the drain
 * window — staleness is a rebind trigger, not a shutdown — and counted on a
 * separate clock: a shrink or growth resets it, an mtime touch does not.
 */
export const STALE_TICKS = 10

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
  /**
   * Positive external evidence of in-flight work (herdr agent_status
   * working/blocked). A HOLD, not a reset: quiet ticks keep accumulating
   * while it returns true, so the drain fires on the first quiet tick after
   * the hold clears rather than starting a fresh window.
   */
  holdOpen?: (terminalId: string) => boolean
  /** The tracker believes a turn is running on this terminal. Gates onStale
   *  — a quiet file under an idle agent is rest, not rot. */
  isInTurn?: (terminalId: string) => boolean
  /**
   * STALE_TICKS polls without byte growth while isInTurn: the watched file
   * is not receiving the claimed work (rotation candidate). Reported at most
   * once per window; the counter is reset BEFORE the call so a rebind inside
   * the handler installs a fresh entry that is not clobbered afterwards.
   */
  onStale?: (terminalId: string) => void
}

export interface SessionWatchOptions {
  /**
   * Skip the synchronous first reconcile — the accept path must not pay a
   * full-file parse inline; the poll timer covers it within one tick.
   */
  deferInitial?: boolean
}

const EMPTY = Buffer.alloc(0)
const NEWLINE = 0x0a

interface WatchedFile {
  file: string
  mtimeMs: number
  /** Bytes read from the file so far — the resume offset for the next read. */
  size: number
  /** File identity: a changed dev/ino is a rotation, never an append. */
  dev: number
  ino: number
  parse: SessionTurnParser
  /** Resumable parser state; null forces the next reconcile to full-parse. */
  acc: SessionTurnAccumulator | null
  /**
   * Trailing bytes past the last newline — a line still being written. Held
   * as BYTES (not text): a UTF-8 sequence split across reads must not be
   * decoded until whole. Fed only once its newline arrives.
   */
  carry: Buffer
  /** Exact tracker array produced by the last successful reconcile. */
  history: TurnRecord[] | null
  /** Focus left this terminal: drain after DRAIN_TICKS without growth. */
  draining: boolean
  /** Consecutive polls without byte growth, counted only while draining. */
  drainTicks: number
  /** Consecutive polls without byte growth, on the stale clock (fix 6). */
  staleTicks: number
}

export class SessionTurnSync {
  private watched = new Map<string, WatchedFile>()
  /** Last verified signature survives a workspace-switch unwatch/reattach. */
  private dormant = new Map<string, WatchedFile>()
  /** In-flight work (a dispatch) holding a released terminal open. */
  private pinned = new Set<string>()
  /** Live viewers (reference-counted): a watched terminal may not drain. */
  private subscribers = new Map<string, number>()
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
  watch(
    terminalId: string,
    file: string,
    parse: SessionTurnParser,
    opts: SessionWatchOptions = {}
  ): void {
    const prior = this.watched.get(terminalId) ?? this.dormant.get(terminalId)
    this.dormant.delete(terminalId)
    if (prior && prior.file === file && prior.parse === parse && prior.history !== null) {
      try {
        const stat = statSync(file)
        const historyIntact = this.turns.history(terminalId) === prior.history
        if (
          historyIntact &&
          stat.mtimeMs === prior.mtimeMs &&
          stat.size === prior.size &&
          stat.dev === prior.dev &&
          stat.ino === prior.ino
        ) {
          // Exact same source and bytes as the last successful reconcile. The
          // TurnTracker intentionally retains history across a workspace
          // detach, so reparsing hundreds of MB cannot make it more exact.
          // Presence pins: a watch() is focus (or a fresh dispatch), so any
          // pending drain is cancelled.
          this.watched.set(terminalId, { ...prior, draining: false, drainTicks: 0, staleTicks: 0 })
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
      dev: 0,
      ino: 0,
      parse,
      acc: null,
      carry: EMPTY,
      history: null,
      draining: false,
      drainTicks: 0,
      staleTicks: 0
    })
    // This file has not proven anything yet — a fresh --session-id boot writes
    // nothing for seconds, and a restore rebinds to a file that may not exist.
    // The scrape covers the window; reconcile() hands over if the file is
    // already there and readable.
    this.turns.setHistorySource(terminalId, 'scrape')
    if (opts.deferInitial !== true) this.reconcile(terminalId)
    this.ensureTimer()
  }

  /**
   * Focus left this terminal's workspace (v5 A4). Do NOT stop watching:
   * work is whatever the session file says it is, and the file growing IS
   * the work. The watch stays live while bytes arrive and drains to a
   * suspended signature after DRAIN_TICKS quiet polls — automatically,
   * with no flag anyone can forget. A pin (in-flight dispatch), a live
   * subscriber, or a truthy holdOpen holds the watch open through the
   * longest quiet tool call.
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

  /**
   * A live viewer opened on this terminal (reference-counted): someone is
   * LOOKING, so the record may not drain out from under them — the same
   * treatment as a pin. The last unsubscribe re-arms the drain clock.
   */
  subscribe(terminalId: string): void {
    this.subscribers.set(terminalId, (this.subscribers.get(terminalId) ?? 0) + 1)
  }

  unsubscribe(terminalId: string): void {
    const count = this.subscribers.get(terminalId) ?? 0
    if (count > 1) {
      this.subscribers.set(terminalId, count - 1)
      return
    }
    this.subscribers.delete(terminalId)
    const watched = this.watched.get(terminalId)
    if (count === 1 && watched && watched.draining) {
      this.watched.set(terminalId, { ...watched, drainTicks: 0 })
    }
  }

  /** Workspace switch only: retain a verified signature for exact reattach. */
  suspend(terminalId: string): void {
    const watched = this.watched.get(terminalId)
    // The signature survives; the accumulator does not — a fallback (non-
    // streaming) accumulator retains every fed line, which a dormant map
    // must not pin in memory. Reattach-then-growth pays one full re-parse.
    if (watched) this.dormant.set(terminalId, { ...watched, acc: null, carry: EMPTY })
    this.stopWatching(terminalId)
  }

  /** Permanent/rebind release: no dormant context may survive it. */
  unwatch(terminalId: string): void {
    this.dormant.delete(terminalId)
    this.pinned.delete(terminalId)
    this.subscribers.delete(terminalId)
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
    this.subscribers.clear()
  }

  private ensureTimer(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.tick(), this.pollMs)
    this.timer.unref?.()
  }

  private tick(): void {
    for (const terminalId of [...this.watched.keys()]) this.reconcile(terminalId)
  }

  /** Anything with positive evidence of interest: no drain while it holds. */
  private held(terminalId: string): boolean {
    return (
      this.pinned.has(terminalId) ||
      (this.subscribers.get(terminalId) ?? 0) > 0 ||
      this.hooks.holdOpen?.(terminalId) === true
    )
  }

  /**
   * A poll where a draining terminal's file did not GROW. Measured in bytes,
   * never mtime — `claude --resume` touches the file it opens without
   * appending, and a touch that reset this clock would hold a dead session
   * watched forever. When the window closes and nothing holds the terminal
   * (pin, subscriber, holdOpen), it drains: suspend, keeping the verified
   * signature so the next watch() costs zero bytes. Holds do not reset the
   * count — the drain fires on the first quiet tick after the hold clears.
   */
  private noteDrainQuiet(terminalId: string, watched: WatchedFile): void {
    if (!watched.draining) return
    const drainTicks = watched.drainTicks + 1
    if (drainTicks < DRAIN_TICKS || this.held(terminalId)) {
      this.watched.set(terminalId, { ...watched, drainTicks })
      return
    }
    this.suspend(terminalId)
  }

  /** Stale clock (fix 6): quiet/touch polls advance it; growth/shrink reset. */
  private noteStaleQuiet(terminalId: string): void {
    const watched = this.watched.get(terminalId)
    // Only a file that has successfully reconciled at least once can go
    // stale — before that, "no growth" describes a file that never started.
    if (!watched || watched.history === null) return
    this.watched.set(terminalId, { ...watched, staleTicks: watched.staleTicks + 1 })
    this.fireStaleIfDue(terminalId)
  }

  private fireStaleIfDue(terminalId: string): void {
    const watched = this.watched.get(terminalId)
    if (!watched || watched.history === null || watched.staleTicks < STALE_TICKS) return
    if (this.hooks.isInTurn?.(terminalId) !== true) return
    // Reset BEFORE the handler: onStale may rebind this terminal onto a
    // different file (watch() installs a fresh entry) and nothing here may
    // write over it afterwards. The reset is also the once-per-window latch.
    this.watched.set(terminalId, { ...watched, staleTicks: 0 })
    this.hooks.onStale?.(terminalId)
  }

  /** Exact byte span [start, end) of a file, via positioned reads. */
  private readSpan(file: string, start: number, end: number): Buffer {
    const fd = openSync(file, 'r')
    try {
      const length = end - start
      const buffer = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, start + read)
        if (n === 0) break
        read += n
      }
      return read === length ? buffer : buffer.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  }

  private reconcile(terminalId: string): void {
    const watched = this.watched.get(terminalId)
    if (!watched) return
    try {
      const stat = statSync(watched.file)
      // Same inode as the last successful reconcile: sizes are comparable and
      // an appended span is resumable. A dev/ino change is a rotation — the
      // offsets mean nothing on the new file.
      const known =
        watched.history !== null && stat.dev === watched.dev && stat.ino === watched.ino
      if (known && stat.mtimeMs === watched.mtimeMs && stat.size === watched.size) {
        // Drain accounting first: the quiet hook may settle a dispatch whose
        // endWork unpins this very entry, and that reset must not be
        // clobbered by a stale copy taken before the callback ran.
        this.noteDrainQuiet(terminalId, watched)
        this.noteStaleQuiet(terminalId)
        this.hooks.onQuiet?.(terminalId)
        return
      }
      // Pure growth resumes the accumulator over the appended span only.
      // Everything else — shrink (/rewind), same-size rewrite with a moved
      // mtime, rotation, first contact — resets and re-parses whole: the
      // one allowed O(S) path.
      const grown = known && watched.acc !== null && stat.size > watched.size
      const acc = grown && watched.acc !== null ? watched.acc : accumulatorFor(watched.parse)
      const span = grown
        ? this.readSpan(watched.file, watched.size, stat.size)
        : this.readSpan(watched.file, 0, stat.size)
      const data = grown ? Buffer.concat([watched.carry, span]) : span
      // Feed only newline-terminated lines; the tail past the last newline is
      // a line mid-write and is held (as bytes — UTF-8 must not be decoded
      // split) until its newline arrives.
      const boundary = data.lastIndexOf(NEWLINE)
      const carry = boundary === -1 ? data : data.subarray(boundary + 1)
      if (boundary !== -1) acc.feed(data.toString('utf8', 0, boundary).split('\n'))
      this.turns.replaceHistory(terminalId, acc.records())
      const moved = !known || stat.size !== watched.size
      this.watched.set(terminalId, {
        ...watched,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        dev: stat.dev,
        ino: stat.ino,
        acc,
        carry,
        history: this.turns.history(terminalId),
        // A shrink is movement too — a /rewind means the agent is writing.
        drainTicks: moved ? 0 : watched.drainTicks + 1,
        staleTicks: moved ? 0 : watched.staleTicks + 1
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
      if (updated?.draining && updated.drainTicks >= DRAIN_TICKS && !this.held(terminalId)) {
        this.suspend(terminalId)
      }
      this.fireStaleIfDue(terminalId)
    } catch {
      // Session file not written yet (fresh --session-id boot) — keep polling,
      // and leave the terminal on the scrape so the turns it takes meanwhile
      // are still recorded.
    }
  }
}

/**
 * The parser's resumable form when it declares one (StreamingTurnParser —
 * Claude's parseSessionTurns does); otherwise a retained-lines fallback:
 * reads stay O(Δ), but records() re-runs the parser over everything fed —
 * the harness's own cost model, unchanged from the pre-incremental world.
 */
function accumulatorFor(parse: SessionTurnParser): SessionTurnAccumulator {
  const streaming = (parse as Partial<StreamingTurnParser>).createAccumulator
  if (streaming !== undefined) return streaming()
  let lines: string[] = []
  return {
    feed(next: string[]): void {
      lines = [...lines, ...next]
    },
    records(): TurnRecord[] {
      return parse(lines)
    }
  }
}
