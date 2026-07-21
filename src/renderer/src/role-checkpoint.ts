// Save-role-from-checkpoint adapter (checkpoint-program-spec, Forge contract
// surface): bridges the roles UI to the AgentRole checkpoint-provenance
// fields {sourceTurnUuid, sourceTurnPrompt, sessionCopyRef}. The UI passes
// only the terminal + checkpoint index; this resolves the record and fills
// the provenance. Demo mode has no role persistence — the UI feature-detects
// and hides the affordance.

import type { AgentRole } from '../../shared/model'
import type { TurnRecord } from '../../shared/turn'
import { cookrew } from './api'

export interface SaveRoleFromCheckpointInput {
  terminalId: string
  /** The checkpoint: its TurnRecord, or its index (resolved via listTurns). */
  checkpoint: TurnRecord | number
  /** Role name typed by the user. */
  name: string
  /** Role prompt; defaults to the checkpoint's prompt text. */
  rolePrompt?: string
}

/** True when this mode can persist roles (desktop IPC / mobile HTTP). */
export function hasRoleFromCheckpoint(): boolean {
  return typeof cookrew().saveRole === 'function'
}

/**
 * Persist a role carrying its checkpoint provenance: the session prompt-entry
 * uuid binds the role to the exact exchange (survives index shifts), and the
 * prompt text keeps it human-readable in the roles list.
 */
export async function saveRoleFromCheckpoint(
  input: SaveRoleFromCheckpointInput
): Promise<AgentRole> {
  const save = cookrew().saveRole
  if (!save) throw new Error('Role saving is unavailable in this mode')
  const record =
    typeof input.checkpoint === 'number'
      ? (await cookrew().listTurns(input.terminalId)).find(
          (t) => t.index === input.checkpoint
        )
      : input.checkpoint
  if (!record) throw new Error(`No checkpoint T${String(input.checkpoint)} recorded for this agent`)
  return save({
    nodeId: input.terminalId,
    name: input.name,
    rolePrompt: input.rolePrompt?.trim() || record.prompt,
    sourceTurnUuid: record.uuid,
    sourceTurnPrompt: record.prompt
  })
}
