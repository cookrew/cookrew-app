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
  /**
   * The checkpoint row's trace identity (its block's message uuid), when the
   * caller knows it. A numeric `checkpoint` is a TRACE-space index (the rail's
   * T-number for the current file), but the ledger it is resolved against
   * CONTINUES its numbering across a /compact — so the ledger record found at
   * that index can be a different turn entirely. When provided, a mismatched
   * ledger record is discarded and the trace fallback (which matches by trace
   * index — always the right space) resolves the checkpoint instead.
   */
  expectedUuid?: string
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
    // The wrong-space join (checkpoint-session-alignment): the lookups above
    // searched the LEDGER by a trace-space index. When the caller supplied the
    // row's real identity and the ledger's record at that index is a different
    // turn, drop it — the trace fallback below resolves in the right space.
    if (record && input.expectedUuid !== undefined && record.uuid !== input.expectedUuid) {
      record = undefined
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
