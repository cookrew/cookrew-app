/**
 * RENAMING A CARD, THE ONE PATH (owner, 2026-11-04). The owner's hands (the
 * zoom card, the full view's head, the phone's bar: IPC `node:rename` and
 * POST /api/nodes/:id/rename), `cookrew rename`, the voice, and Sous naming a
 * new agent from its prompt all rename through renameCardIn, so they agree on
 * what a name may be (shared/rename-plan.ts · planRename) and a clash is
 * answered in the same words wherever it was typed.
 *
 * A NAME SOMEBODY CHOSE IS PINNED. A caller says so (`pin`): the owner's
 * hands, `cookrew rename` and the voice do, Sous never does. On an agent the
 * pin is `nameByHand`, written by main alone (store.updateNodeUnsafe; a
 * renderer's or phone's patch cannot set or clear it), and Sous never names
 * over a pinned card afterwards (autoNameMayReplace). stillStandIn alone
 * could not tell a choice that happens to equal the stand-in (Enter on the
 * same name, or "Login (2)") from the stand-in itself.
 */
import type { CanvasNode } from '../shared/model'
import { EMPTY_NAME_ERROR, planRename, stillStandIn, type RenameOutcome } from '../shared/rename-plan'

export { EMPTY_NAME_ERROR, planRename, stillStandIn, type RenameOutcome, type RenamePlanInput } from '../shared/rename-plan'

export interface RenameDeps {
  /** The card and its workspace, on any canvas (store.nodeAcrossWorkspaces). */
  find: (id: string) => { node: CanvasNode; workspaceId: string } | undefined
  /** Every card of that workspace: notes and browsers are addressed by name too. */
  siblings: (workspaceId: string) => readonly { id: string; name: string }[]
  /** index.ts · updateNode: an agent's herdr pane title, tab and agent name follow, and the rename is recorded. */
  update: (id: string, patch: Partial<CanvasNode>, by?: string) => unknown
  /** Pin an agent's name against Sous: main's own write, outside the patch allow-list. */
  pin: (id: string) => unknown
}

const pinned = (node: CanvasNode | undefined): boolean => node?.kind === 'terminal' && node.nameByHand === true

/**
 * Should a name a model picked replace the card's? Only while the card still
 * wears the stand-in it was given, and nobody pinned a name on it by hand.
 */
export function autoNameMayReplace(node: CanvasNode | undefined, standIn: string): boolean {
  if (!node || pinned(node)) return false
  return stillStandIn(node.name, standIn)
}

/**
 * Rename a card: planned against its workspace's other cards, then through
 * the one update. A note's new name is pinned against its content
 * (customName); an agent's, when `pin`, against Sous (nameByHand), also when
 * the chosen name is the one it already wears.
 */
export function renameCardIn(
  deps: RenameDeps,
  id: string,
  wanted: string,
  onClash: 'refuse' | 'suffix',
  pin: boolean,
  by?: string
): RenameOutcome {
  const hit = deps.find(id)
  if (!hit) return { ok: false, error: 'That card is not on any canvas.' }
  const { node } = hit
  const plan = planRename({ id, current: node.name, wanted, siblings: deps.siblings(hit.workspaceId), onClash })
  if (!plan.ok) return plan
  if (plan.changed) deps.update(id, node.kind === 'note' ? { name: plan.name, customName: plan.name } : { name: plan.name }, by)
  if (pin && node.kind === 'terminal' && !pinned(node)) deps.pin(id)
  return plan
}

/**
 * The owner's own rename, as the IPC and the phone's route receive it: the
 * arguments are checked here, once, for both. A name someone typed is
 * refused on a clash, never suffixed.
 */
export function renameByHand(deps: RenameDeps, id: unknown, wanted: unknown): RenameOutcome {
  if (typeof id !== 'string' || id === '') return { ok: false, error: 'That card is not on any canvas.' }
  if (typeof wanted !== 'string') return { ok: false, error: EMPTY_NAME_ERROR }
  return renameCardIn(deps, id, wanted, 'refuse', true)
}

/**
 * The name Sous picks for a card made from a prompt (agent-namer.ts), once it
 * answers. Null when it has nothing better, or when the card wears a choice by
 * then — renamed while it thought, or pinned by hand at any time: a guess
 * never overwrites a choice.
 */
export async function autoNameIn(
  deps: RenameDeps & { pick: (prompt: string) => Promise<string | null> },
  id: string,
  standIn: string,
  prompt: string
): Promise<RenameOutcome | null> {
  if (!autoNameMayReplace(deps.find(id)?.node, standIn)) return null
  const picked = await deps.pick(prompt)
  if (!picked) return null
  const hit = deps.find(id)
  if (!hit || hit.node.kind !== 'terminal' || !autoNameMayReplace(hit.node, standIn)) return null
  return renameCardIn(deps, id, picked, 'suffix', false, 'Sous (named from the prompt)')
}
