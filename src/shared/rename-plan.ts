/**
 * RENAMING AN AGENT (owner, 2026-11-01): `cookrew rename`, a recruit's name
 * from its prompt, and the global prompt box's model-picked name all land
 * through here, so they agree on what a name may be.
 *
 * A name is an ADDRESS, not just a label: `cookrew ask "Name"` resolves it in
 * the caller's workspace and refuses an ambiguous one (socket-server.ts). So
 * a name somebody chose that another card already wears is refused, never
 * silently suffixed — the caller would go on addressing a name that is not
 * the one the card wears. A name a MODEL chose is suffixed instead: nobody is
 * holding it yet.
 *
 * Pure, in shared/: the main process plans every rename with it
 * (main/agent-rename.ts), and the renderer's demo api plans the same way.
 */
import { cleanAgentName } from './agent-name'

/** What an empty or whitespace name is answered, here and in the renderer's own check. */
export const EMPTY_NAME_ERROR = 'A name needs at least one letter or digit.'

export type RenameOutcome = { ok: true; name: string; changed: boolean } | { ok: false; error: string }

export interface RenamePlanInput {
  id: string
  current: string
  wanted: string
  /** Every other card of the agent's workspace (any kind: notes and browsers are addressed by name too). */
  siblings: readonly { id: string; name: string }[]
  /** 'refuse' for a name someone typed; 'suffix' for one a model picked. */
  onClash: 'refuse' | 'suffix'
}

export function planRename({ id, current, wanted, siblings, onClash }: RenamePlanInput): RenameOutcome {
  const name = cleanAgentName(wanted)
  if (name === '') return { ok: false, error: EMPTY_NAME_ERROR }
  if (name === current) return { ok: true, name, changed: false }
  const taken = new Set(siblings.filter((s) => s.id !== id).map((s) => s.name.trim().toLowerCase()))
  if (!taken.has(name.toLowerCase())) return { ok: true, name, changed: true }
  if (onClash === 'refuse') {
    return { ok: false, error: `"${name}" is already a card in this workspace. Pick another name.` }
  }
  for (let n = 2; ; n += 1) {
    const next = `${name} (${n})`
    if (!taken.has(next.toLowerCase())) return { ok: true, name: next, changed: next !== current }
  }
}

/**
 * Should a model's name replace the stand-in? Only while the card still wears
 * the stand-in: a rename that landed while the model was thinking — by the
 * owner, by the agent itself — is a choice, and outranks a guess.
 */
export function stillStandIn(currentName: string | undefined, standIn: string): boolean {
  if (currentName === undefined) return false
  return currentName === standIn || new RegExp(`^${escapeRe(standIn)} \\(\\d+\\)$`, 'u').test(currentName)
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
