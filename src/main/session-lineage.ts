// Claude session lineage — the node's breadcrumb trail across /clear,
// restore, undo, and re-resolves. ONE pure helper so every rebind path
// (restore executor, spawn-time resolver, future /clear adoption) records
// the transition identically: the rail unions checkpoints across these
// files, and cross-clear rewind cuts into them.
//
// APPEND-ONLY, AND WHY THE CAP HAD TO GO (2026-09-06)
// --------------------------------------------------
// This function used to end with `slice(lineage.length - SESSION_LINEAGE_CAP)`
// at a cap of 20. That line is the fourth "I lost my checkpoints": the owner's
// busiest card was sitting at exactly 20, so its NEXT rebind would have thrown
// away the oldest session id — and with it a whole transcript that no rail, no
// rewind and no recovery can address any more. Nothing errored, nothing was
// logged, and the transcript itself was still on disk: the checkpoints were
// not destroyed, they were made unreachable.
//
// An id is 36 bytes and one is recorded per rotation (hours apart, at best),
// so the bound the cap was defending — a canvas node's payload — was never
// worth a lost conversation: 1,000 rotations is 37 KB of workspace.json.
//
// Durability is a separate concern and lives in lineage-spill.ts: this array
// is one mutable blob that other paths legitimately clear (a preset scrub, a
// team copy), so every id recorded here is also written to a per-node file.
// Readers take node lineage ∪ spill.

import type { TerminalNodeData } from '../shared/model'

/**
 * The node patch for rebinding to `newSessionId`: the new binding plus the
 * OLD id appended to the lineage (oldest first). No lineage entry when
 * nothing changes (reattach), when there was no prior binding (first boot),
 * or when the id is already on the chain — lineage records TRANSITIONS, and
 * recording one twice would grow the array on every re-resolve of a fork that
 * came back to an id it had already used.
 *
 * Immutable and total: the input node is never touched, and NOTHING is ever
 * removed from the chain.
 */
export function withSessionLineage(
  node: Pick<TerminalNodeData, 'claudeSessionId' | 'sessionLineage'>,
  newSessionId: string
): Pick<TerminalNodeData, 'claudeSessionId' | 'sessionLineage'> {
  const old = node.claudeSessionId
  const lineage = node.sessionLineage ?? []
  if (!old || old === newSessionId || lineage.includes(old)) {
    return { claudeSessionId: newSessionId, sessionLineage: lineage }
  }
  return { claudeSessionId: newSessionId, sessionLineage: [...lineage, old] }
}

/**
 * Every id a lineage patch asserts, current binding included — what the
 * durable record is asked to hold. Kept here so the store's spill hook and
 * the rebind paths cannot disagree about what "the chain" means.
 */
export function lineageIdsOf(
  node: Pick<TerminalNodeData, 'claudeSessionId' | 'sessionLineage'>
): string[] {
  const ids = [...(node.sessionLineage ?? [])]
  if (node.claudeSessionId) ids.push(node.claudeSessionId)
  return ids.filter((id, at) => id.length > 0 && ids.indexOf(id) === at)
}
