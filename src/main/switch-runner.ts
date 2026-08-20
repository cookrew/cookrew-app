/**
 * Perform a workspace switch without stopping the world.
 *
 * planWorkspaceSwitch decides WHAT a switch does; this decides HOW it is run.
 * The two were one synchronous loop inside store.on('switch'), and that loop
 * booted every terminal on the incoming canvas back to back with no yield.
 * Each boot is a herdr attach, so on a 16-terminal workspace the Electron main
 * thread was held for ~90 SECONDS — and the companion HTTP server shares that
 * thread, so for those ninety seconds the app answered nothing, on any address.
 *
 * Before slugs that was bad. With slugs it is worse and differently shaped:
 * every phone on every workspace sees a dead app because someone at the desktop
 * changed which canvas they were looking at. R13 promises a switch is cheap and
 * that a workspace keeps running while you look elsewhere; an app that stops
 * answering breaks both halves of that at once.
 *
 * TWO THINGS ARE LOAD-BEARING and survive intact:
 *
 *   SERIAL ORDER. Boots stay strictly ordered — each PTY must exist before its
 *   pendingInject delivery. This yields BETWEEN boots; it does not run them
 *   concurrently.
 *
 *   ONE ATTACH BATCH. The herdr pane inventory is taken once for the whole
 *   reattach. Dropping that turns fork cost from O(1) into O(terminals), which
 *   the baseline probe priced at 44.8x (34 panes, 2026-08-20).
 *
 * What this does NOT claim: an individual boot still blocks while it runs. One
 * ninety-second stall becomes N short ones with gaps the server can answer in.
 * That is the honest description — responsiveness, not concurrency.
 */

export interface SwitchRunnerDeps<T, B> {
  /** Detach one terminal's PTY and stop watching it. Fast; stays inline. */
  detach: (terminalId: string) => void
  /** Boot one terminal. Synchronous and expensive — this is what we yield around. */
  boot: (terminal: T) => void
  /** Hand the browser runtime the full desired set. */
  syncBrowsers: (browsers: readonly B[]) => void
  /** Re-report external chrome once the incoming canvas is up. */
  onBooted: () => void
  beginBatch: () => void
  endBatch: () => void
  /** Give the event loop a turn. setImmediate in production. */
  yieldToLoop: () => Promise<void>
}

export interface SwitchPlanLike<T, B> {
  detach: readonly string[]
  boot: readonly T[]
  browsers: readonly B[]
}

/**
 * Runs switches such that a newer one supersedes an older one mid-flight.
 *
 * A switch can arrive while the previous one is still booting — a user clicking
 * through the switcher does it routinely, and now that each boot yields there
 * is real time for it to happen in. The superseded run stops where it is and
 * does NOT close the batch: the run that replaced it owns that now.
 */
export class SwitchRunner<T, B> {
  private generation = 0

  constructor(private readonly deps: SwitchRunnerDeps<T, B>) {}

  async run(plan: SwitchPlanLike<T, B>): Promise<void> {
    const generation = (this.generation += 1)

    for (const terminalId of plan.detach) this.deps.detach(terminalId)

    // Close any batch a superseded run left open before opening ours: its
    // snapshot is as old as that run, and a switch that has been waiting
    // through another switch's boots must not reattach against stale panes.
    this.deps.endBatch()
    this.deps.beginBatch()
    try {
      for (const terminal of plan.boot) {
        // A newer switch has taken over. Stop; it owns the batch now, so
        // closing it here would pull the inventory out from under it.
        if (generation !== this.generation) return
        this.deps.boot(terminal)
        await this.deps.yieldToLoop()
      }
      if (generation !== this.generation) return
      this.deps.syncBrowsers(plan.browsers)
      this.deps.onBooted()
    } finally {
      // Only the CURRENT run closes. A superseded one leaving here must not.
      if (generation === this.generation) this.deps.endBatch()
    }
  }
}
