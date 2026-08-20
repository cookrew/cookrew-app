/**
 * What a workspace switch does, as a decision separate from its effects.
 *
 * This lived inline in index.ts's `store.on('switch')` handler, tangled with
 * Electron and a dozen singletons, and so was never tested. That is exactly
 * how H1 shipped: a `continue` that skipped a live terminal looked like it
 * skipped only the PTY spawn, when it actually skipped owner-input hooks, the
 * producer lease, turn tracking, registry recording and pending-inject
 * delivery too. No test could have caught it, because there was nothing a test
 * could call.
 *
 * So the decision is a pure function over facts and the handler performs what
 * it returns. Flag-off equivalence — that one resident workspace produces
 * exactly the pre-refactor behaviour — becomes something a test can assert
 * rather than something a commit message can claim.
 */

/** Facts the decision is made from. All read-only. */
export interface SwitchFacts<T, B> {
  /** Terminals that were on the outgoing canvas. */
  previousTerminalIds: readonly string[]
  /** Which workspace holds a terminal's PTY, if any holds it. */
  workspaceOfTerminal: (terminalId: string) => string | undefined
  /** Is this workspace still held in memory? */
  isResident: (workspaceId: string) => boolean
  /** Terminals on the canvas being switched TO. */
  focusedTerminals: readonly T[]
  /** Browsers of every resident workspace, focused or not. */
  residentBrowsers: readonly B[]
}

export interface SwitchPlan<T, B> {
  /**
   * PTYs to detach — never kill. The tmux session stays alive so returning
   * reattaches it with its agent and scrollback intact.
   */
  detach: string[]
  /**
   * Terminals to (re)register. EVERY focused terminal, whether or not its PTY
   * is already live: registration is far more than the spawn, and the spawn
   * itself short-circuits. This is the H1 invariant.
   */
  boot: readonly T[]
  /**
   * The full browser set the runtime should hold. replaceNodes() is a
   * replace-the-WORLD call — anything absent is stopped — so this is the union
   * across resident workspaces, not just the focused canvas's.
   */
  browsers: readonly B[]
}

/**
 * Decide a switch.
 *
 * A terminal is detached only when the workspace holding it is no longer
 * resident. With one workspace resident (flag off) that is every outgoing
 * terminal, which is the pre-refactor teardown exactly; with several, the
 * workspace you looked away from keeps its live screens.
 *
 * A terminal whose PTY belongs to no workspace at all is detached: it is held
 * by nothing that can be responsible for it later.
 */
export function planWorkspaceSwitch<T, B>(facts: SwitchFacts<T, B>): SwitchPlan<T, B> {
  const detach = facts.previousTerminalIds.filter((terminalId) => {
    const holder = facts.workspaceOfTerminal(terminalId)
    return holder === undefined || !facts.isResident(holder)
  })

  return {
    detach,
    boot: facts.focusedTerminals,
    browsers: facts.residentBrowsers
  }
}
