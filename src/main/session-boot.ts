/**
 * BOOT-IN-PLACE — a served workspace's terminals come alive without a switch.
 *
 * Slice 1 added `bootTerminals?` to `forkTeam` because boot and focus were one
 * act: a fork ended by calling `switchWorkspace`, whose side effect is what
 * spawned the terminals. That is correct for the owner forking on their own
 * canvas and wrong for anything created on their behalf — a SERVED session would
 * yank the owner's screen to a stranger's workspace on that stranger's first
 * call, once per caller, forever.
 *
 * WHY THIS IS A PLAN + LOOP AND NOT A STORE CHANGE. The PTY spawn reads no
 * focus: `PtyManager.spawn` takes a terminal id, a command, a cwd and an owning
 * workspace id, and nothing in the create/attach path consults `focusedId`. So a
 * terminal in a NON-focused workspace can be spawned given its own node — which
 * means booting a workspace in place is exactly "spawn each of its terminals,"
 * with no teardown of the current one (build no detach list) and no focus move.
 * The switch machinery couples the three only because, until now, nothing needed
 * them apart.
 *
 * NO PROSE, NO SPAWN HERE. This decides WHICH nodes boot and in what order; the
 * spawn itself (harness resume, env, the pty) is the injected `boot`, which in
 * index.ts is the existing per-terminal `bootTerminal`. Keeping the spawn behind
 * the seam is what lets the selection be tested without a pty — and lets the one
 * served-only concern (a scrubbed, confined spawn) live in that injected boot
 * rather than leak into this loop.
 */

/** A node as boot reads it — the minimal shape the selection needs. */
export interface BootNode {
  id: string
  kind: string
}

/**
 * The terminals of a workspace, in node order — the ones a boot spawns. Browsers
 * and other node kinds are not processes this boots, so they are dropped here
 * rather than filtered at every call site.
 */
export function planBootInPlace<N extends BootNode>(nodes: readonly N[]): N[] {
  return nodes.filter((n) => n.kind === 'terminal')
}

export interface BootInPlaceDeps<N extends BootNode> {
  /** The ADDRESSED workspace's own nodes — never the focused canvas's. */
  nodesOf(workspaceId: string): readonly N[]
  /**
   * Spawn one terminal in place. index.ts wires this to `bootTerminal`.
   *
   * MUST BE IDEMPOTENT. `bootWorkspaceInPlace` may run more than once for a
   * workspace (a retried fork, a reconnect), so `boot` has to skip a terminal
   * whose pty is already alive — `PtyManager.spawn` is idempotent, which is what
   * makes this safe. The seam does not dedup; the spawn does.
   */
  boot(node: N): void
  /** Told when a terminal's boot threw, so a partial boot is not silent. */
  onError?(node: N, error: unknown): void
}

/**
 * Boot every terminal of a workspace in place, and return how many booted
 * WITHOUT throwing. Calls only `boot` per terminal — never a switch, never a
 * detach — so the owner's canvas does not move and their current workspace's
 * terminals are left running. This is the function index.ts passes as
 * `forkTeam`'s `bootTerminals` for a served session.
 *
 * ONE BAD NODE DOES NOT STRAND ITS SIBLINGS. A served workspace whose orch boots
 * but whose workers do not is a worse, quieter failure than a loud one, so each
 * boot is isolated: a throw is reported through `onError` and the loop goes on.
 * The count is successes, so a caller can tell a full boot from a partial one.
 */
export function bootWorkspaceInPlace<N extends BootNode>(
  deps: BootInPlaceDeps<N>,
  workspaceId: string
): number {
  const terminals = planBootInPlace(deps.nodesOf(workspaceId))
  let booted = 0
  for (const terminal of terminals) {
    try {
      deps.boot(terminal)
      booted++
    } catch (error) {
      deps.onError?.(terminal, error)
    }
  }
  return booted
}
