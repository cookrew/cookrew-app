// WHAT IS SELECTED ON THE STAGE, and what each column shows because of it.
//
// The stage is three columns: the workspace's browsers and notes on the left,
// the thing you are looking at in the middle, its agents on the right. The
// two side columns filter each other through the canvas wiring:
//
//   auto  — nothing chosen: the middle follows what needs you (stage-pick.ts),
//           both columns show everything
//   agent — an agent's terminal in the middle; the left shows only ITS
//           browsers and notes, and one of them opens in the lower half
//   item  — a browser or note in the middle; the right shows only the agents
//           wired to it
//
// A store, not component state: the app picks from outside the stage too (a
// card asked for by the command box or a toast lands here).
import { useSyncExternalStore } from 'react'
import type { AgentRow } from '../agent-rows'
import type { AttachmentIndex, TerminalAttachment } from '../terminal-attachments'

export type StageSelection = { kind: 'auto' } | { kind: 'agent'; id: string } | { kind: 'item'; id: string }

const AUTO: StageSelection = { kind: 'auto' }
let selection: StageSelection = AUTO
const listeners = new Set<() => void>()

const same = (a: StageSelection, b: StageSelection): boolean => a.kind === b.kind && (a.kind === 'auto' || a.id === (b as { id: string }).id)

export const stageSelect = {
  get: (): StageSelection => selection,
  set(next: StageSelection): void {
    if (same(selection, next)) return
    selection = next
    for (const listener of listeners) listener()
  },
  /** Back to following what needs you. */
  clear(): void {
    stageSelect.set(AUTO)
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

export const useStageSelection = (): StageSelection => useSyncExternalStore(stageSelect.subscribe, stageSelect.get, stageSelect.get)

/** A browser or note of the workspace, as its card on the left says it. */
export interface StageItemCard {
  id: string
  kind: 'browser' | 'note'
  title: string
  /** The browser's host and path; the note's first real line. */
  sub: string
  /** The agents wired to it, newest wire first. */
  owners: string[]
  attachment: TerminalAttachment
}

/** item id → the agents wired to it: the canvas wiring read the other way. */
export function ownersOf(index: AttachmentIndex): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [terminalId, list] of index) {
    for (const a of list) out.set(a.node.id, [...(out.get(a.node.id) ?? []), terminalId])
  }
  return out
}

export interface StageColumns {
  items: StageItemCard[]
  agents: AgentRow[]
  /** The left is filtered to this agent's items. */
  itemsFor: string | null
  /** The right is filtered to this item's agents. */
  agentsFor: string | null
}

/** What each side column shows for a selection. Order is kept: the caller's order is the column's. */
export function stageColumns(selection: StageSelection, items: readonly StageItemCard[], agents: readonly AgentRow[], index: AttachmentIndex): StageColumns {
  if (selection.kind === 'agent' && agents.some((a) => a.id === selection.id)) {
    const mine = index.get(selection.id) ?? []
    const byId = new Map(items.map((i) => [i.id, i]))
    return {
      items: mine.flatMap((a) => {
        const card = byId.get(a.node.id)
        return card ? [card] : []
      }),
      agents: [...agents],
      itemsFor: selection.id,
      agentsFor: null
    }
  }
  if (selection.kind === 'item') {
    const item = items.find((i) => i.id === selection.id)
    if (item) {
      const wired = new Set(item.owners)
      return { items: [...items], agents: agents.filter((a) => wired.has(a.id)), itemsFor: null, agentsFor: item.id }
    }
  }
  return { items: [...items], agents: [...agents], itemsFor: null, agentsFor: null }
}

/** A note's first line worth reading: not blank, not a heading mark alone. */
export function firstLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim()
    if (line) return line
  }
  return ''
}

/** "https://example.com/a/b?q#f" → "example.com/a/b". */
export function hostPath(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return url
  }
}
