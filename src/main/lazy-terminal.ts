import type { HerdrStatus } from './herdr-agent-status'

export interface LazyTerminalDeps {
  /** Ensure the local PTY mirror exists. The remote agent process is separate. */
  attach: (terminalId: string) => boolean
  /** Drop only the local mirror; the multiplexer-owned agent keeps running. */
  detach: (terminalId: string) => void
  /** True while either the backend or the local tracker says work is active. */
  isWorking: (terminalId: string) => boolean
  /** Start attach-free session-file observation for a working agent. */
  watchWorking: (terminalId: string) => void
}

/**
 * Owns demand for local PTY mirrors.
 *
 * A canvas full of terminals must not become a canvas full of PTY attaches at
 * startup. A mirror exists only while at least one transcript viewer needs it,
 * or while an agent that was viewed is still working. Backend status can start
 * the cheaper session-file watcher, but never opens a PTY by itself.
 */
export class LazyTerminalAttachments {
  private readonly viewers = new Map<string, number>()

  constructor(private readonly deps: LazyTerminalDeps) {}

  /** Ensure a mirror without adding another viewer reference. */
  ensure(terminalId: string): boolean {
    return this.deps.attach(terminalId)
  }

  /** A zoomed transcript opened. Returns false when the terminal cannot attach. */
  acquire(terminalId: string): boolean {
    if (!this.ensure(terminalId)) return false
    this.viewers.set(terminalId, (this.viewers.get(terminalId) ?? 0) + 1)
    return true
  }

  /** A transcript closed. The last idle viewer releases the local mirror. */
  release(terminalId: string): void {
    const count = this.viewers.get(terminalId) ?? 0
    if (count > 1) this.viewers.set(terminalId, count - 1)
    else this.viewers.delete(terminalId)
    this.trim(terminalId)
  }

  /** Herdr status is enough to watch a transcript file, never to open a PTY. */
  observeStatus(terminalId: string, status: HerdrStatus): void {
    if (status === 'working') this.deps.watchWorking(terminalId)
    this.trim(terminalId)
  }

  /** Re-check after the local turn tracker changes phase. */
  reconsider(terminalId: string): void {
    this.trim(terminalId)
  }

  viewerCount(terminalId: string): number {
    return this.viewers.get(terminalId) ?? 0
  }

  private trim(terminalId: string): void {
    if (this.viewerCount(terminalId) > 0 || this.deps.isWorking(terminalId)) return
    this.deps.detach(terminalId)
  }
}
