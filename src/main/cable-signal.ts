import { isCableSignal, type CableSignal, type CableSignalKind } from '../shared/cable-signal'

/**
 * THE SIGNAL BUS — where "A asked B" and "B answered A" become one frame each.
 *
 * Two producers mint signals: the CLI ask (socket-server cmdAsk), which knows
 * both ends because the caller's pane is the sender; and the dispatch engine
 * (dispatch.ts), for `ask --no-wait`, which carries the sender as an
 * in-memory `origin` on the record. The owner's own asks — phone, HTTP route,
 * Sous — have no origin and mint nothing: there is no cable from the owner.
 *
 * One listener sends the frame to the desktop renderer over IPC; the mobile
 * API attaches one per /api/events stream. Listeners are fire-and-forget: a
 * throwing bridge must never reach the dispatch or the ask that produced the
 * moment, which is the same contract `announce` already has.
 */
export class CableSignalBus {
  private readonly listeners = new Set<(signal: CableSignal) => void>()

  constructor(private readonly now: () => number = Date.now) {}

  on(listener: (signal: CableSignal) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Mint one signal. A malformed moment (empty id, a card asking itself) is
   * dropped here rather than lighting nothing on the canvas and logging a
   * stack: the producers pass whatever identity they resolved, and resolving
   * is their job, not the bus's.
   */
  emit(moment: { from: string; to: string; kind: CableSignalKind }): boolean {
    const signal: CableSignal = { from: moment.from, to: moment.to, kind: moment.kind, at: this.now() }
    if (!isCableSignal(signal)) return false
    for (const listener of this.listeners) {
      try {
        listener(signal)
      } catch (error) {
        console.error('Cable signal listener failed:', error)
      }
    }
    return true
  }

  get size(): number {
    return this.listeners.size
  }
}
