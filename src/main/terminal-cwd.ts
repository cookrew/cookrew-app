// Moving a terminal card to another working directory.
//
// Lives outside index.ts so the ORDER — enroll, repoint, release, kill,
// carry, spawn — is unit-testable with plain fakes. Every step of it is
// load-bearing:
//
//   enroll  a directory reached through the file browser is not yet a member
//           of the workspace, and the store refuses a cwd that is not one.
//   release stop reconciling turn records against the OLD session file
//           before it stops being this terminal's file.
//   kill    AND WAIT: a kill returns before the multiplexer has torn the
//           session down, and `new-session -A` then reattaches the dying one
//           and ignores the boot command (H5, the same race endpoint restore
//           has to await) — which here would silently keep the agent in the
//           OLD directory or leave it dead.
//   carry   make the conversation resolvable from the new directory, so the
//           respawn resumes it (session-move.ts) instead of booting empty.
//   spawn   last, so the boot resolves against a session that is already there.

import type { CanvasNode, TerminalNodeData } from '../shared/model'
import type { SessionMoveOptions, SessionMoveOutcome } from './session-move'

export interface TerminalCwdDeps {
  store: {
    activeId: string
    node: (id: string) => CanvasNode | undefined
    /** Directories of the ACTIVE workspace (the only canvas a card moves on). */
    dirs: () => string[]
    addWorkspaceDir: (workspaceId: string, dir: string) => unknown
    setTerminalCwd: (nodeId: string, dir: string) => TerminalNodeData
  }
  /** Drop the turn tracker and the session-file reconcile for this terminal. */
  release: (terminalId: string) => void
  /** Kill the session and RESOLVE ONLY once it is really gone (throws if not). */
  kill: (terminalId: string) => Promise<void>
  spawn: (node: TerminalNodeData) => void
  carry: (move: SessionMoveOptions) => SessionMoveOutcome
  dirExists: (dir: string) => boolean
}

/**
 * Repoint a terminal at `dir` and respawn it there, carrying its
 * conversation across. Returns the moved node. A directory the workspace
 * does not have yet is added to it first — that is what makes the file
 * browser a real escape hatch rather than a picker that always throws.
 */
export async function moveTerminalCwd(
  deps: TerminalCwdDeps,
  nodeId: string,
  dir: string
): Promise<TerminalNodeData> {
  const target = dir.trim().replace(/(.)\/+$/, '$1')
  if (target.length === 0) throw new Error('Directory path must not be empty')
  const node = deps.store.node(nodeId)
  if (!node || node.kind !== 'terminal') throw new Error('Not a terminal node')
  const terminal = node as TerminalNodeData
  // Same directory: no kill, so no respawn. Re-running the move would cost a
  // working agent its turn for nothing.
  if (terminal.cwd === target) return terminal

  if (!deps.store.dirs().includes(target)) {
    // Only the enrolment path checks the filesystem: an existing member may
    // be temporarily unmounted, and refusing to move BACK onto it would
    // strand the card. A new one that isn't there would just fail to spawn.
    if (!deps.dirExists(target)) throw new Error(`'${target}' is not a directory`)
    deps.store.addWorkspaceDir(deps.store.activeId, target)
  }

  const moved = deps.store.setTerminalCwd(nodeId, target)
  deps.release(nodeId)
  try {
    await deps.kill(nodeId)
  } catch (error) {
    // The old session outlived its kill, so it is STILL RUNNING in the old
    // directory. Spawning now would reattach that survivor and report a move
    // that never happened — put the store back where reality is, reattach
    // the agent that is still there, and let the failure surface.
    deps.store.setTerminalCwd(nodeId, terminal.cwd)
    deps.spawn(terminal)
    throw error
  }
  deps.carry({ node: terminal, fromCwd: terminal.cwd, toCwd: target })
  deps.spawn(moved)
  return moved
}
