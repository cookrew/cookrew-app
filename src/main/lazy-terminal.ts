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
  /**
   * Is a local mirror actually resident? Only a mirror can be kept alive, and
   * trim() is reached for every terminal in every workspace at boot and on
   * every status/turn event — arming a window for terminals that have no
   * mirror would defer their file-watch and turn-tracker release fleet-wide
   * for nothing. Absent = assume resident (tests, embedders).
   */
  resident?: (terminalId: string) => boolean
  /** Timer injection, so the linger is testable without waiting it out. */
  schedule?: (run: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  /** Grace before a viewerless mirror is dropped; see MIRROR_LINGER_MS. */
  lingerMs?: number
  /** Most mirrors that may linger at once; see MIRROR_LINGER_MAX. */
  lingerMax?: number
}

/**
 * How long a mirror outlives its last viewer.
 *
 * Releasing on the spot was correct arithmetic and the wrong behaviour: a
 * phone page left open for hours goes black, because iOS reaps a backgrounded
 * tab's connections, the SSE close releases the only viewer, and under herdr
 * `detach` DISPOSES the session. The page comes back, boots a fresh mirror,
 * and gets a replay frame of an empty screen — which an idle agent (measured:
 * zero idle bytes) never repaints. The link flapping is not the user leaving,
 * so the mirror waits to be sure.
 *
 * 45s, not longer: it covers a backgrounded tab's reap, a tunnel, a lock
 * screen — and a retained mirror is not free (a headless xterm with 5000
 * lines of scrollback AND a spawned attach client), so the window is priced
 * against holding N of them. A non-focused workspace's session drain
 * (15-20s) will beat this window anyway; there the repaint kick is what
 * saves the pane.
 */
const MIRROR_LINGER_MS = 45_000

/**
 * How many mirrors may linger at once. Zooming through a canvas would
 * otherwise hold one process per card visited within the window; past this
 * the oldest window is closed early — it has already had its chance.
 */
const MIRROR_LINGER_MAX = 6

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
  /** Armed linger timers, per terminal — insertion order is age. */
  private readonly lingering = new Map<string, unknown>()
  private readonly schedule: (run: () => void, ms: number) => unknown
  private readonly cancel: (handle: unknown) => void
  private readonly lingerMs: number
  private readonly lingerMax: number

  constructor(private readonly deps: LazyTerminalDeps) {
    this.schedule =
      deps.schedule ??
      ((run, ms) => {
        const timer = setTimeout(run, ms)
        // Background waits never hold the app open (house convention).
        timer.unref?.()
        return timer
      })
    this.cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.lingerMs = deps.lingerMs ?? MIRROR_LINGER_MS
    this.lingerMax = deps.lingerMax ?? MIRROR_LINGER_MAX
  }

  /** Ensure a mirror without adding another viewer reference. */
  ensure(terminalId: string): boolean {
    return this.deps.attach(terminalId)
  }

  /** A zoomed transcript opened. Returns false when the terminal cannot attach. */
  acquire(terminalId: string): boolean {
    if (!this.ensure(terminalId)) return false
    // A viewer arriving disarms the window: this is the reconnect it exists
    // for, and the mirror it finds is the one it left. Disarmed only once the
    // attach is known to have worked.
    this.disarm(terminalId)
    this.viewers.set(terminalId, (this.viewers.get(terminalId) ?? 0) + 1)
    return true
  }

  /** A transcript closed. The last idle viewer starts the mirror's linger. */
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

  /**
   * Forget a terminal entirely — it was retired. A reborn id must never
   * inherit a dead generation's window, which would detach the fresh mirror.
   */
  forget(terminalId: string): void {
    this.disarm(terminalId)
    this.viewers.delete(terminalId)
  }

  /** Drop every armed linger — app shutdown. */
  dispose(): void {
    for (const handle of this.lingering.values()) this.cancel(handle)
    this.lingering.clear()
  }

  private disarm(terminalId: string): void {
    const handle = this.lingering.get(terminalId)
    if (handle === undefined) return
    this.cancel(handle)
    this.lingering.delete(terminalId)
  }

  private trim(terminalId: string): void {
    if (this.viewerCount(terminalId) > 0 || this.deps.isWorking(terminalId)) {
      this.disarm(terminalId)
      return
    }
    // Nothing to keep alive: the old immediate path, which also releases the
    // file watch and the turn tracker. Only a resident mirror earns a window.
    if (this.deps.resident && !this.deps.resident(terminalId)) {
      this.disarm(terminalId)
      this.deps.detach(terminalId)
      return
    }
    // Re-arm rather than stack: the newest release owns the window.
    this.disarm(terminalId)
    this.lingering.set(
      terminalId,
      this.schedule(() => {
        this.lingering.delete(terminalId)
        // Asked again at the moment of the act — a viewer may have returned,
        // or the agent may have started working, since the window opened.
        if (this.viewerCount(terminalId) > 0 || this.deps.isWorking(terminalId)) return
        this.deps.detach(terminalId)
      }, this.lingerMs)
    )
    while (this.lingering.size > this.lingerMax) {
      const oldest = this.lingering.keys().next()
      if (oldest.done === true) break
      this.disarm(oldest.value)
      this.deps.detach(oldest.value)
    }
  }
}
