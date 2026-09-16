import type { PaneCardInfo } from './multiplexer'

/**
 * THE CARD A PANE WEARS IN HERDR'S OWN CHROME, AND HOW IT SURVIVES A SERVER
 * THAT WAS REPLACED UNDER IT.
 *
 * herdr persists pane LAYOUT, not the metadata a source reported against it.
 * ensureSession already re-reports the binding on every attach for exactly
 * that reason — but it only runs for terminals this process is ATTACHING, and
 * a Cookrew fleet is mostly panes belonging to workspaces nobody has opened
 * yet. Measured across the 0.8.2 -> 0.9.0 live handoff on 2026-09-10: 33 of 56
 * panes carried a title before, 5 after, and the missing 28 came back one at a
 * time as each card was opened. In between, herdr's sidebar shows raw shells
 * and every tool that resolves an agent by title (scratchpad/orch-status.mjs)
 * answers "pane not found" for a fleet that is running perfectly.
 *
 * So the binding is re-asserted for EVERY terminal at boot, not only the ones
 * being attached. It is display-only — Cookrew's control flow never reads any
 * of it back — which is why it can be this blunt, and why a failure here must
 * never be able to fail a boot.
 */

/** What a terminal node has to offer for its pane to be named. */
export interface BindableTerminal {
  readonly id: string
  readonly name: string
  readonly role: string | null
  readonly preset: string
  readonly cwd: string
}

/**
 * THE CARD, IN ONE PLACE.
 *
 * `workspace` is the card's OWN workspace, never the focused one. A sweep that
 * stamped the focused workspace's name onto every pane would relabel the whole
 * fleet each time the owner switched canvas — herdr's sidebar would say a
 * Baymax agent lives in Cookrew Dev, which is worse than saying nothing.
 */
export const paneCardFor = (terminal: BindableTerminal, workspace: string): PaneCardInfo => ({
  terminalId: terminal.id,
  title: terminal.name,
  agent: terminal.role ?? terminal.preset,
  workspace,
  cwd: terminal.cwd
})

export interface PaneBindingDeps {
  /** Every terminal node in EVERY workspace — `store.terminalsAcross()`. */
  readonly terminals: () => readonly BindableTerminal[]
  /** The name of the workspace that owns this terminal. */
  readonly workspaceOf: (terminalId: string) => string
  /** `sessionNameFor` — the label the pane wears. */
  readonly sessionName: (terminalId: string) => string
  /** The multiplexer's reportPaneCard. A no-op when no pane wears the label. */
  readonly report: (sessionName: string, card: PaneCardInfo) => void
  /** One shared pane listing for the whole sweep, where the backend has one. */
  readonly beginBatch?: () => void
  readonly endBatch?: () => void
}

/**
 * Re-assert every terminal's pane binding. Returns how many were offered —
 * NOT how many landed, because only the backend knows which labels have panes.
 *
 * ONE LISTING FOR THE WHOLE SWEEP. Without the batch, each report resolves its
 * pane by forking `herdr pane list`, and a few hundred terminals would be a
 * few hundred forks on the Electron main thread at boot.
 *
 * A REPORT THAT THROWS DOES NOT STOP THE SWEEP, and the batch closes either
 * way: this is cosmetic work running on the boot path, and the one outcome it
 * must not have is a fleet that fails to start because a pane could not be
 * named.
 */
export const reportAllPaneBindings = (deps: PaneBindingDeps): number => {
  let offered = 0
  deps.beginBatch?.()
  try {
    for (const terminal of deps.terminals()) {
      try {
        deps.report(deps.sessionName(terminal.id), paneCardFor(terminal, deps.workspaceOf(terminal.id)))
        offered += 1
      } catch {
        // One pane that cannot be named is not the other fifty-five.
      }
    }
  } finally {
    deps.endBatch?.()
  }
  return offered
}
