// Claude session lineage — the node's breadcrumb trail across /clear,
// restore, undo, and re-resolves. ONE pure helper so every rebind path
// (restore executor, spawn-time resolver, future /clear adoption) records
// the transition identically: the rail unions checkpoints across these
// files, and cross-clear rewind cuts into them.

import type { TerminalNodeData } from '../shared/model'

/** How many prior session ids the lineage keeps per node. */
export const SESSION_LINEAGE_CAP = 20

/**
 * The node patch for rebinding to `newSessionId`: the new binding plus the
 * OLD id appended to the lineage (oldest first, capped). No lineage entry
 * when nothing changes (reattach) or there was no prior binding (first boot)
 * — lineage records TRANSITIONS, not states.
 */
export function withSessionLineage(
  node: Pick<TerminalNodeData, 'claudeSessionId' | 'sessionLineage'>,
  newSessionId: string
): Pick<TerminalNodeData, 'claudeSessionId' | 'sessionLineage'> {
  const old = node.claudeSessionId
  if (!old || old === newSessionId) {
    return { claudeSessionId: newSessionId, sessionLineage: node.sessionLineage ?? [] }
  }
  const lineage = [...(node.sessionLineage ?? []), old]
  return {
    claudeSessionId: newSessionId,
    sessionLineage: lineage.length > SESSION_LINEAGE_CAP ? lineage.slice(lineage.length - SESSION_LINEAGE_CAP) : lineage
  }
}
