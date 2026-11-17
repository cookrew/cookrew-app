/**
 * The loaded workspace's cards, as back from a full view needs them
 * (full-return.ts): what each is called on the ‹, and which were closed.
 * Read off the workspace's nodes, never the zoom's model, whose grid is cut
 * short (zoom-model.ts · ITEMS_SHOWN) and would forget a card that is there.
 */
import { activeBrowserTab, type CanvasNode } from '../../../shared/model'
import type { FullKind } from './full-return'

export interface BackCards {
  readonly nameOf: (kind: FullKind, id: string) => string | null
}

/** One look at a workspace's cards, to tell a closed card from one of another workspace. */
export interface CardsSeen {
  readonly workspaceId: string | null
  readonly ids: ReadonlySet<string>
}

export const cardsSeenOf = (workspaceId: string | null, nodes: readonly CanvasNode[]): CardsSeen => ({ workspaceId, ids: new Set(nodes.map((n) => n.id)) })

/**
 * The cards closed between two looks at the SAME workspace. A card of another
 * workspace (a pet, a toast or the command box can open one) is not closed,
 * and a switch closes nothing: the trail may still lead back there.
 */
export function goneCards(before: CardsSeen | null, after: CardsSeen): ReadonlySet<string> {
  if (before === null || before.workspaceId !== after.workspaceId) return new Set()
  return new Set([...before.ids].filter((id) => !after.ids.has(id)))
}

const kindOf = (node: CanvasNode): FullKind => (node.kind === 'terminal' ? 'agent' : 'item')

/** An agent by its name; a browser by its page's title, as its full view's head says (StageView.tsx); a note by its name. */
const nameOfNode = (node: CanvasNode): string => {
  if (node.kind === 'browser') return activeBrowserTab(node).title?.trim() || node.name
  return node.name
}

export function backCardsOf(nodes: readonly CanvasNode[]): BackCards {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const find = (kind: FullKind, id: string): CanvasNode | null => {
    const node = byId.get(id)
    return node !== undefined && kindOf(node) === kind ? node : null
  }
  return {
    nameOf: (kind, id) => {
      const node = find(kind, id)
      return node === null ? null : nameOfNode(node).trim() || null
    }
  }
}
