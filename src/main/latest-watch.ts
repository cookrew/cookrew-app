import { watch, type FSWatcher } from 'node:fs'

/**
 * Trace-perf T4: push, not poll. A card that is showing its latest checkpoint
 * (T1) wants to reflect a new turn the instant the session file grows, not on
 * the next poll tick. This watches the resolved session file per terminal —
 * refcounted, so N cards on one file share one watcher — and fires `onChange`
 * (debounced) when it changes.
 *
 * It is the IMMEDIACY layer only. The renderer keeps a slow poll as the
 * correctness backstop, because fs.watch is lossy by nature: FSEvents coalesces
 * bursts and a watcher dies on rotation (Claude rolls the session file, the
 * inode moves). So a 'rename' re-resolves and re-arms rather than trusting the
 * old handle, and anything the watch drops the poll still catches.
 */
export interface LatestFileWatcherDeps {
  /** The session file for a terminal, or null when it has none yet. */
  resolveFile: (terminalId: string) => string | null
  /** Fire when that file changed (already debounced). */
  onChange: (terminalId: string) => void
  /** Coalesce a burst of append events into one push. */
  debounceMs?: number
  /** Bounded re-resolve attempts after a rename/miss before giving up to poll. */
  rearmMs?: number
}

interface Entry {
  count: number
  file: string | null
  watcher: FSWatcher | null
  debounce: ReturnType<typeof setTimeout> | null
  rearm: ReturnType<typeof setTimeout> | null
}

export class LatestFileWatcher {
  private readonly entries = new Map<string, Entry>()
  private readonly debounceMs: number
  private readonly rearmMs: number

  constructor(private readonly deps: LatestFileWatcherDeps) {
    this.debounceMs = deps.debounceMs ?? 150
    this.rearmMs = deps.rearmMs ?? 2000
  }

  /** A card began showing this terminal's checkpoint. */
  subscribe(terminalId: string): void {
    const existing = this.entries.get(terminalId)
    if (existing) {
      this.entries.set(terminalId, { ...existing, count: existing.count + 1 })
      return
    }
    const entry: Entry = { count: 1, file: null, watcher: null, debounce: null, rearm: null }
    this.entries.set(terminalId, entry)
    this.arm(terminalId)
  }

  /** The card is gone (unmounted / live view took over). */
  unsubscribe(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    if (entry.count > 1) {
      this.entries.set(terminalId, { ...entry, count: entry.count - 1 })
      return
    }
    this.teardown(entry)
    this.entries.delete(terminalId)
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.teardown(entry)
    this.entries.clear()
  }

  /** Resolve the file and start watching it; a no-op when there is none yet. */
  private arm(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    const file = this.deps.resolveFile(terminalId)
    if (!file) {
      // No file yet (agent never ran, id still phantom). Retry a few times, then
      // leave it to the poll backstop — a card that never gets a file is fine.
      this.scheduleRearm(terminalId)
      return
    }
    let watcher: FSWatcher
    try {
      watcher = watch(file, (eventType) => this.onEvent(terminalId, eventType))
    } catch {
      this.scheduleRearm(terminalId)
      return
    }
    // A watcher error (deleted file, fs quirk) must not crash the process — drop
    // it and let a rearm re-resolve.
    watcher.on('error', () => this.rearmAfterLoss(terminalId))
    this.entries.set(terminalId, { ...entry, file, watcher })
  }

  private onEvent(terminalId: string, eventType: string): void {
    // 'rename' means the file moved out from under us (rotation, delete). The
    // handle is now stale, so re-resolve rather than keep watching a ghost.
    if (eventType === 'rename') {
      this.rearmAfterLoss(terminalId)
      return
    }
    const entry = this.entries.get(terminalId)
    if (!entry) return
    if (entry.debounce) return // a push is already scheduled for this burst
    const debounce = setTimeout(() => {
      const live = this.entries.get(terminalId)
      if (live) this.entries.set(terminalId, { ...live, debounce: null })
      this.deps.onChange(terminalId)
    }, this.debounceMs)
    this.entries.set(terminalId, { ...entry, debounce })
  }

  /** Close the current watcher and schedule a re-resolve. */
  private rearmAfterLoss(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        /* already gone */
      }
    }
    this.entries.set(terminalId, { ...entry, watcher: null, file: null })
    // A rotation still means "something changed" — push so the card re-reads the
    // new file's tail immediately, not on the next poll.
    this.deps.onChange(terminalId)
    this.scheduleRearm(terminalId)
  }

  private scheduleRearm(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry || entry.rearm) return
    const rearm = setTimeout(() => {
      const live = this.entries.get(terminalId)
      if (!live) return
      this.entries.set(terminalId, { ...live, rearm: null })
      if (!this.entries.get(terminalId)?.watcher) this.arm(terminalId)
    }, this.rearmMs)
    this.entries.set(terminalId, { ...entry, rearm })
  }

  private teardown(entry: Entry): void {
    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        /* already gone */
      }
    }
    if (entry.debounce) clearTimeout(entry.debounce)
    if (entry.rearm) clearTimeout(entry.rearm)
  }
}
