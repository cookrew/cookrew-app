// Endpoint restore planner — rewind a teammate IN PLACE to any checkpoint.
//
// Why this exists: Claude Code's own /rewind picker only offers checkpoints for
// messages still in context, so a compact silently drops the earlier ones (a
// 10-day session can fall from ~194 offers to 8). Cookrew parses the session
// FILE, so its checkpoint rail already sees EVERY endpoint — this planner turns
// "restore to checkpoint N" into an exact message-uuid cutoff, which the fork
// engine's buildForkedSessionLinesAtUuid can truncate on.
//
// The restore never mutates the original session: it writes a TRUNCATED COPY
// under a fresh id and rebinds the node, pushing the previous session onto an
// undo stack so a rewind is always reversible.
//
// Pure so the decision unit-tests without Electron or the filesystem.

import { harnessFor, type HarnessId } from './harness'
import type { RestorePoint } from '../shared/model'

export type { RestorePoint }

/** A checkpoint as the trace index knows it: ordinal + stable identity. */
export interface CheckpointRef {
  index: number
  /** Claude: the prompt-entry message uuid. Codex: a 'p<ordinal>' string. */
  id: string
  /**
   * Session file this checkpoint lives in — present when the rail unions
   * across a node's lineage (a checkpoint from BEFORE a /clear sits in an
   * older file). Absent = the node's currently bound session.
   */
  sessionId?: string
}

export interface RestorePlan {
  ok: boolean
  /** Why the restore is refused (shown to the user — never fail silently). */
  reason?: string
  /** Message uuid to truncate the session copy at (inclusive). */
  cutoffUuid?: string
  /** Session FILE the cutoff lives in (lineage union); default = current binding. */
  cutoffSessionId?: string
  harness?: HarnessId
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Decide whether checkpoint `checkpointIndex` can be restored, and on which
 * exact message uuid to cut. Refusals are explicit so the UI can say why
 * instead of pretending a rewind happened.
 */
export function planCheckpointRestore(input: {
  command: string
  sessionId?: string | null
  checkpointIndex: number
  blocks: readonly CheckpointRef[]
}): RestorePlan {
  const harness = harnessFor(input.command)
  if (!harness) return { ok: false, reason: 'This is a plain shell — there is no session to restore.' }
  if (harness.id !== 'claude') {
    return {
      ok: false,
      harness: harness.id,
      reason: `Endpoint restore isn't supported for ${harness.id} yet — its rollout format has no truncation path.`
    }
  }
  if (!input.sessionId) {
    return { ok: false, harness: harness.id, reason: 'No bound session file for this agent yet.' }
  }
  // AUDITED for the two-index-space bug (checkpoint-session-alignment,
  // 2026-08-30) and found CORRECT by construction: the index resolves against
  // the TRACE blocks — the current file's own numbering, the space the rail
  // shows — and the cut binds to the block's uuid below. This is the shape
  // forkClaudeSession had to be repaired INTO; a rewind never consulted the
  // ledger, so a compact's continued numbering cannot misdirect it.
  const block = input.blocks.find((b) => b.index === input.checkpointIndex)
  if (!block) {
    return { ok: false, harness: harness.id, reason: `No checkpoint ${input.checkpointIndex} in this session.` }
  }
  // Cut ONLY on a real message uuid — never on a positional guess.
  if (!UUID_RE.test(block.id)) {
    return {
      ok: false,
      harness: harness.id,
      reason: `Checkpoint ${input.checkpointIndex} has no exact message identity to cut on.`
    }
  }
  return {
    ok: true,
    harness: harness.id,
    cutoffUuid: block.id,
    ...(block.sessionId !== undefined ? { cutoffSessionId: block.sessionId } : {})
  }
}

/** How many undo steps we keep per agent. */
export const RESTORE_UNDO_CAP = 10

/** Push a restore point (newest first), immutably, capped. */
export function pushRestorePoint(
  stack: readonly RestorePoint[],
  entry: RestorePoint,
  cap: number = RESTORE_UNDO_CAP
): RestorePoint[] {
  return [entry, ...stack].slice(0, cap)
}
