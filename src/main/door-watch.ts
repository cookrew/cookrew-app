/**
 * LIVENESS FOR A RECORD THAT LIVES SOMEWHERE ELSE.
 *
 * A local card learns that its session file grew from fs.watch (latest-watch)
 * and is nudged the same instant. A remote card's file is at the author's
 * machine, and the door offers no push — so while a card is subscribed (an
 * idle card showing its last checkpoint, an open overlay) this asks the door
 * on a short interval and pushes the SAME nudge when the answer changes.
 * Nothing is asked for a card nobody is looking at.
 *
 * Refcounted per terminal like the file watcher: N views of one card share
 * one poll. Probes never overlap; a slow door just misses ticks.
 */
export interface DoorWatchDeps {
  /** A string that changes when the card should redraw; null = not a door card. */
  probe: (terminalId: string) => Promise<string | null>
  onChange: (terminalId: string) => void
  intervalMs?: number
}

interface Entry {
  count: number
  timer: ReturnType<typeof setInterval>
  last: string | null
  busy: boolean
}

export const DOOR_POLL_MS = 2000

export class DoorWatch {
  private readonly entries = new Map<string, Entry>()
  private readonly intervalMs: number

  constructor(private readonly deps: DoorWatchDeps) {
    this.intervalMs = deps.intervalMs ?? DOOR_POLL_MS
  }

  subscribe(terminalId: string): void {
    const existing = this.entries.get(terminalId)
    if (existing) {
      this.entries.set(terminalId, { ...existing, count: existing.count + 1 })
      return
    }
    const timer = setInterval(() => void this.tick(terminalId), this.intervalMs)
    this.entries.set(terminalId, { count: 1, timer, last: null, busy: false })
    void this.tick(terminalId)
  }

  unsubscribe(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    if (entry.count > 1) {
      this.entries.set(terminalId, { ...entry, count: entry.count - 1 })
      return
    }
    clearInterval(entry.timer)
    this.entries.delete(terminalId)
  }

  /** Is any view holding this card's poll open. */
  watching(terminalId: string): boolean {
    return this.entries.has(terminalId)
  }

  /** The card is gone: drop its poll whatever the count — no view can
   *  unsubscribe a node that no longer resolves. */
  forget(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    clearInterval(entry.timer)
    this.entries.delete(terminalId)
  }

  dispose(): void {
    for (const entry of this.entries.values()) clearInterval(entry.timer)
    this.entries.clear()
  }

  private async tick(terminalId: string): Promise<void> {
    const entry = this.entries.get(terminalId)
    if (!entry || entry.busy) return
    this.entries.set(terminalId, { ...entry, busy: true })
    let seen: string | null = null
    try {
      seen = await this.deps.probe(terminalId)
    } catch {
      seen = null
    }
    const live = this.entries.get(terminalId)
    if (!live) return
    this.entries.set(terminalId, { ...live, busy: false, last: seen ?? live.last })
    // The FIRST answer is a baseline, not a change: the card has already read
    // once on mount, and a nudge here would only make it read the same twice.
    if (seen !== null && live.last !== null && seen !== live.last) this.deps.onChange(terminalId)
  }
}
