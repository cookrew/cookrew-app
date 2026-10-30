import { isUseSignal, type UseSignal } from '../shared/use-signal'

/**
 * THE USE BUS — where "agent A acted on card C, here" becomes one frame.
 *
 * One producer (the agent command engine, use-commands.ts), two kinds of
 * listener: the desktop renderer over IPC and each phone's /api/events
 * stream. Listeners are fire-and-forget, the contract the cable-signal bus
 * has: a throwing bridge must never reach the command that acted.
 */
export class UseSignalBus {
  private readonly listeners = new Set<(signal: UseSignal) => void>()

  on(listener: (signal: UseSignal) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(signal: UseSignal): boolean {
    if (!isUseSignal(signal)) return false
    for (const listener of this.listeners) {
      try {
        listener(signal)
      } catch {
        // A viewer's bridge failing is never the action's failure.
      }
    }
    return true
  }
}
