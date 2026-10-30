// WHERE THE STAGE IS, and what each column shows because of it.
//
// Four levels, one route (device / workspace / card in the header):
//
//   devices    — every device
//   workspaces — every workspace of the device, as thumbnails
//   workspace  — one workspace: all its browsers and notes, all its agents,
//                and the newest card that needs you in the middle
//   card       — one card zoomed in: the sides keep only what is wired to it
//
// The last two are the same three columns; the selection below says which.
//
// The stage is three columns: the workspace's browsers and notes on the left,
// the thing you are looking at in the middle, its agents on the right. The
// two side columns filter each other through the canvas wiring:
//
//   auto  — the workspace level: the middle follows what needs you
//           (stage-pick.ts), both columns show everything
//   agent — an agent's terminal zoomed in; the left keeps ITS browsers and
//           notes (one opens in the lower half), the right keeps it and the
//           agents wired to it — by a cable or through a shared card
//   item  — a browser or note zoomed in; the right keeps its agents, the
//           left keeps the card itself
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

export type StageLevel = 'devices' | 'workspaces' | 'workspace'

let level: StageLevel = 'workspace'
const levelListeners = new Set<() => void>()

export const stageLevel = {
  get: (): StageLevel => level,
  set(next: StageLevel): void {
    if (next === level) return
    level = next
    for (const listener of levelListeners) listener()
  },
  subscribe(listener: () => void): () => void {
    levelListeners.add(listener)
    return () => {
      levelListeners.delete(listener)
    }
  }
}

export const useStageLevel = (): StageLevel => useSyncExternalStore(stageLevel.subscribe, stageLevel.get, stageLevel.get)

export const stageSelect = {
  get: (): StageSelection => selection,
  set(next: StageSelection): void {
    // A pick is always on a workspace's columns.
    if (next.kind !== 'auto') stageLevel.set('workspace')
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
  /** The card zoomed in: both sides keep only what is wired to it. */
  focus: { kind: 'agent' | 'item'; id: string } | null
}

/**
 * What each side column shows for a selection. Order is kept: the caller's
 * order is the column's. `links` are the agent-to-agent cables.
 */
export function stageColumns(
  selection: StageSelection,
  items: readonly StageItemCard[],
  agents: readonly AgentRow[],
  index: AttachmentIndex,
  links: ReadonlyMap<string, ReadonlySet<string>> = new Map()
): StageColumns {
  if (selection.kind === 'agent' && agents.some((a) => a.id === selection.id)) {
    const mine = new Set((index.get(selection.id) ?? []).map((a) => a.node.id))
    const near = new Set<string>([selection.id, ...(links.get(selection.id) ?? [])])
    for (const item of items) if (mine.has(item.id)) for (const owner of item.owners) near.add(owner)
    return {
      // Newest wire first, as the agent's own list has them.
      items: (index.get(selection.id) ?? []).flatMap((a) => items.filter((i) => i.id === a.node.id)),
      agents: agents.filter((a) => near.has(a.id)),
      focus: { kind: 'agent', id: selection.id }
    }
  }
  if (selection.kind === 'item') {
    const item = items.find((i) => i.id === selection.id)
    if (item) {
      const wired = new Set(item.owners)
      return { items: [item], agents: agents.filter((a) => wired.has(a.id)), focus: { kind: 'item', id: item.id } }
    }
  }
  return { items: [...items], agents: [...agents], focus: null }
}

/** agent id → the agents a cable joins it to, either way. */
export function agentLinks(connections: readonly { a: string; b: string }[], agentIds: ReadonlySet<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const { a, b } of connections) {
    if (!agentIds.has(a) || !agentIds.has(b) || a === b) continue
    out.set(a, (out.get(a) ?? new Set()).add(b))
    out.set(b, (out.get(b) ?? new Set()).add(a))
  }
  return out
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
