import type { CanvasNode, WorkspaceState } from './model'

/**
 * THE CARDS OF A WORKSPACE, AS A SCENE CAN USE THEM — for ANY workspace, not
 * just the loaded one.
 *
 * The world view shows a workspace as a place: its agents, and the notes and
 * browsers wired to each of them. The canvas only ever holds the ACTIVE
 * workspace's cards, and switching to another one stops its terminals, so a
 * map that needed the switch to show a workspace's equipment would be a map
 * you cannot read without disturbing the thing it describes. The store can
 * read a parked workspace's state from disk (WorkspaceStore.workspaceState),
 * so this is that state reduced to what a scene needs, read without a switch.
 *
 * IT CARRIES NAMES AND SHAPES, NOTHING ELSE. No note bodies, no browser URLs,
 * no commands, no session ids: a name is what a chip shows, and a position is
 * where the card stands. The same rule workspace-map.ts keeps for the wall's
 * thumbnails, one notch looser because an equipment chip has to be readable.
 *
 * Pure, so the reduction and the wiring rule are tested without a store.
 */

export interface WorkspaceCard {
  id: string
  kind: CanvasNode['kind']
  /** The name a card shows on the canvas — a note's custom name wins. */
  name: string
  x: number
  y: number
  w: number
  h: number
}

export interface WorkspaceCards {
  id: string
  cards: WorkspaceCard[]
  /** Connections with both ends on this canvas; the far end of a mirrored
   *  cross-workspace edge is not a card here and is dropped. */
  links: Array<{ a: string; b: string }>
}

/** Nothing to show. One value, so callers compare against one thing. */
export const EMPTY_CARDS: WorkspaceCards = { id: '', cards: [], links: [] }

function nameOf(node: CanvasNode): string {
  if (node.kind === 'note' && typeof node.customName === 'string' && node.customName.trim()) {
    return node.customName
  }
  return node.name
}

/** A workspace's cards and links, or EMPTY_CARDS for a missing state. */
export function workspaceCards(id: string, state: WorkspaceState | null | undefined): WorkspaceCards {
  const nodes = state?.nodes ?? []
  if (nodes.length === 0) return { ...EMPTY_CARDS, id }
  const cards = nodes.map(
    (node): WorkspaceCard => ({
      id: node.id,
      kind: node.kind,
      name: nameOf(node),
      x: node.position?.x ?? 0,
      y: node.position?.y ?? 0,
      w: Math.max(1, node.size?.width ?? 1),
      h: Math.max(1, node.size?.height ?? 1)
    })
  )
  const here = new Set(cards.map((c) => c.id))
  const links = (state?.connections ?? [])
    .filter((c) => here.has(c.a) && here.has(c.b))
    .map((c) => ({ a: c.a, b: c.b }))
  return { id, cards, links }
}

/**
 * Agent → the notes and browsers wired to it.
 *
 * A card belongs to the FIRST terminal that claims it, so a note cabled to two
 * agents is shown once; a card wired only to other cards belongs to nobody and
 * stands on its own. The same rule the world's first version applied to the
 * active canvas, now for any workspace.
 */
export function equipmentOf(cards: WorkspaceCards): Map<string, WorkspaceCard[]> {
  const byId = new Map(cards.cards.map((c) => [c.id, c]))
  const out = new Map<string, WorkspaceCard[]>()
  const taken = new Set<string>()
  for (const link of cards.links) {
    const a = byId.get(link.a)
    const b = byId.get(link.b)
    if (!a || !b) continue
    const pair =
      a.kind === 'terminal' && b.kind !== 'terminal'
        ? ([a, b] as const)
        : b.kind === 'terminal' && a.kind !== 'terminal'
          ? ([b, a] as const)
          : null
    if (pair === null || taken.has(pair[1].id)) continue
    taken.add(pair[1].id)
    const list = out.get(pair[0].id)
    if (list) list.push(pair[1])
    else out.set(pair[0].id, [pair[1]])
  }
  return out
}
