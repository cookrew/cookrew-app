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
  let record = typeof input.checkpoint === 'number' ? undefined : input.checkpoint
  if (typeof input.checkpoint === 'number') {
    const api = cookrew()
    if (api.listTurnsPage) {
      const page = await api.listTurnsPage(input.terminalId, {
        aroundIndex: input.checkpoint,
        limit: 1
      })
      record = page.turns.find((turn) => turn.index === input.checkpoint)
    } else {
      record = (await api.listTurns(input.terminalId)).find((turn) => turn.index === input.checkpoint)
    }
    // A capped ledger can omit an old trace identity. The trace window still
    // owns its exact prompt and stable id, so one explicit ROLE action may read
    // that single body without restoring the overlay's full-history fetch.
    if (!record && api.listTrace) {
      const page = await api.listTrace(input.terminalId, {
        aroundIndex: input.checkpoint,
        limit: 1
      })
      const block = page.blocks.find(
        (candidate): candidate is {
          id: string
          index: number
          prompt: string
          startedAt: number
          endedAt: number
        } =>
          typeof candidate === 'object' &&
          candidate !== null &&
          (candidate as { index?: unknown }).index === input.checkpoint &&
          typeof (candidate as { id?: unknown }).id === 'string' &&
          typeof (candidate as { prompt?: unknown }).prompt === 'string' &&
          typeof (candidate as { startedAt?: unknown }).startedAt === 'number' &&
          typeof (candidate as { endedAt?: unknown }).endedAt === 'number'
      )
      if (block) {
        record = {
          index: block.index,
          prompt: block.prompt,
          reply: '',
          uuid: block.id,
          startedAt: block.startedAt,
          endedAt: block.endedAt
        }
      }
    }
  }
  if (!record) throw new Error(`No checkpoint T${String(input.checkpoint)} recorded for this agent`)
  return save({
    nodeId: input.terminalId,
    name: input.name,
    rolePrompt: input.rolePrompt?.trim() || record.prompt,
    sourceTurnUuid: record.uuid,
    sourceTurnPrompt: record.prompt
  })
}
