import type { CanvasNode, WorkspaceState } from '../../shared/model'

/**
 * THE PUSH DOES NOT CARRY GIT; THE PULL DOES.
 *
 * The companion embeds each terminal's git state only on GET /api/workspace
 * (enrichStateWithGit); the event stream's `workspace` frames are the raw
 * canvas. A client that replaced its state wholesale on every push lost the
 * field on the first change after boot, every GitChip saw `undefined` and
 * fetched /api/git per card — the thirty requests perf lane L7 removed,
 * back through the relay a minute later. So a pushed terminal that says
 * nothing about git keeps what the previous state knew. A node that is new,
 * or a state with nothing to carry (the desktop IPC path never embeds it),
 * is returned as pushed. Pure.
 */
export function carryGit(previous: WorkspaceState | null, pushed: WorkspaceState): WorkspaceState {
  if (previous === null) return pushed
  const known = new Map<string, CanvasNode>()
  for (const node of previous.nodes) if (node.kind === 'terminal' && node.git !== undefined) known.set(node.id, node)
  if (known.size === 0) return pushed
  let carried = false
  const nodes = pushed.nodes.map((node) => {
    if (node.kind !== 'terminal' || node.git !== undefined) return node
    const before = known.get(node.id)
    if (before === undefined || before.kind !== 'terminal' || before.cwd !== node.cwd) return node
    carried = true
    return { ...node, git: before.git }
  })
  return carried ? { ...pushed, nodes } : pushed
}
