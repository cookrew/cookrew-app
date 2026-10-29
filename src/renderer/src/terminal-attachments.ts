// A TERMINAL'S OWN BROWSERS AND NOTES, from the canvas wiring.
//
// The wire is the relation: `browser create` wires the new browser to the
// terminal that asked for it, and on the owner's canvas 95% of browsers and
// notes are wired to at least one terminal (2026-10-29). So a zoomed terminal
// can carry them inside its own card without guessing.
//
// Newest wire first: connections are appended as they are made, so the end of
// the list is the most recent — the browser an agent just opened leads.
import { createContext } from 'react'
import { activeBrowserTab, type BrowserNodeData, type CanvasNode, type Connection, type NoteNodeData } from '../../shared/model'

export type TerminalAttachment =
  | { kind: 'browser'; node: BrowserNodeData }
  | { kind: 'note'; node: NoteNodeData }

export type AttachmentIndex = ReadonlyMap<string, readonly TerminalAttachment[]>

export const NO_ATTACHMENTS: readonly TerminalAttachment[] = []

export function attachmentIndex(
  nodes: readonly CanvasNode[],
  connections: readonly Connection[]
): AttachmentIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = new Map<string, TerminalAttachment[]>()
  for (let i = connections.length - 1; i >= 0; i--) {
    const { a, b } = connections[i]
    for (const [terminalId, otherId] of [
      [a, b],
      [b, a]
    ]) {
      const terminal = byId.get(terminalId)
      const other = byId.get(otherId)
      if (terminal?.kind !== 'terminal' || other === undefined) continue
      const item: TerminalAttachment | null =
        other.kind === 'browser' ? { kind: 'browser', node: other } : other.kind === 'note' ? { kind: 'note', node: other } : null
      if (item === null) continue
      const list = out.get(terminalId) ?? []
      if (list.some((x) => x.node.id === other.id)) continue
      out.set(terminalId, [...list, item])
    }
  }
  return out
}

/** What a card shows of an item: changes here re-render the card, nothing else does. */
function face(item: TerminalAttachment): string {
  if (item.kind === 'note') return `n|${item.node.id}|${item.node.name}|${item.node.content}|${item.node.locked ? 1 : 0}`
  return `b|${item.node.id}|${item.node.name}|${activeBrowserTab(item.node).url}`
}

/**
 * Same index for every card that reads it? The workspace object changes on
 * every status tick and every drag; without this, each one would re-render the
 * zoomed terminal for nothing.
 */
export function sameAttachmentIndex(a: AttachmentIndex, b: AttachmentIndex): boolean {
  if (a.size !== b.size) return false
  for (const [id, list] of a) {
    const other = b.get(id)
    if (other === undefined || other.length !== list.length) return false
    for (let i = 0; i < list.length; i++) if (face(list[i]) !== face(other[i])) return false
  }
  return true
}

/** From this many on, the side tabs offer a filter. */
export const FIND_FROM = 8

/** The items whose name or address contains the query; every item for an empty one. */
export function filterAttachments(items: readonly TerminalAttachment[], query: string): readonly TerminalAttachment[] {
  const q = query.trim().toLowerCase()
  return q === '' ? items : items.filter((a) => face(a).toLowerCase().includes(q))
}

export const TerminalAttachmentsContext = createContext<AttachmentIndex>(new Map())
