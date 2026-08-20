/**
 * Which workspace each live PTY belongs to.
 *
 * Step 2 of the multi-instance refactor (marketplace-architecture §11) lets N
 * workspaces hold live runtimes at once. The obvious move — one PtyManager per
 * session — is the wrong one twice over:
 *
 *   1. `allTerminalIdsStrict()` is the orphan reaper's fail-safe and has to see
 *      EVERY terminal the app owns, whoever is holding it. Sharding the map
 *      would hand the reaper a partial ownership set, and a terminal missing
 *      from that set is a terminal it kills.
 *   2. Cost. The baseline probe (34 panes, 2026-08-20) measured unbatched pane
 *      resolution at 44.8x batched, linear in K against a flat line. One
 *      shared inventory is what keeps it flat; N managers each running their
 *      own discovery is exactly the O(attached x panes) shape that took
 *      /api/activity from 190ms to 6.85s in August (ef5e13c post-mortem).
 *
 * So the map stays one map and a scope is a filtered VIEW over it. This class
 * is only the index that makes the view possible: terminal id -> workspace id,
 * with the reverse direction maintained alongside so a per-workspace query
 * costs nothing.
 *
 * A terminal has exactly ONE holder. Claiming it somewhere else moves it —
 * which is what a cut-and-paste across workspaces does, keeping the id — so no
 * scope can ever tear down a PTY another scope is holding.
 */
export class PtyOwnership {
  private readonly byTerminal = new Map<string, string>()
  private readonly byWorkspace = new Map<string, Set<string>>()

  /** Record that a workspace holds this terminal, moving it if it was held. */
  claim(terminalId: string, workspaceId: string): void {
    this.release(terminalId)
    this.byTerminal.set(terminalId, workspaceId)
    const held = this.byWorkspace.get(workspaceId) ?? new Set<string>()
    held.add(terminalId)
    this.byWorkspace.set(workspaceId, held)
  }

  /** Forget one terminal. No-op when it was never claimed. */
  release(terminalId: string): void {
    const previous = this.byTerminal.get(terminalId)
    if (previous === undefined) return
    this.byTerminal.delete(terminalId)
    const held = this.byWorkspace.get(previous)
    if (!held) return
    held.delete(terminalId)
    if (held.size === 0) this.byWorkspace.delete(previous)
  }

  /** Forget every terminal a workspace held, returning their ids. */
  releaseWorkspace(workspaceId: string): string[] {
    const held = this.byWorkspace.get(workspaceId)
    if (!held) return []
    const ids = [...held]
    for (const id of ids) {
      this.byTerminal.delete(id)
    }
    this.byWorkspace.delete(workspaceId)
    return ids
  }

  workspaceOf(terminalId: string): string | undefined {
    return this.byTerminal.get(terminalId)
  }

  /** Terminals one workspace is holding — the scope's membership. */
  idsFor(workspaceId: string): string[] {
    return [...(this.byWorkspace.get(workspaceId) ?? [])]
  }

  /** Every held terminal, across every workspace — the reaper's view. */
  all(): string[] {
    return [...this.byTerminal.keys()]
  }
}
