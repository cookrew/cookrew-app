// WHERE THE STAGE IS, and what each column shows because of it.
//
// Two levels of the loaded workspace, one route (workspace / card in the header):
//
//   workspace  — all its browsers and notes, all its agents, and the newest
//                card that needs you in the middle
//   card       — one card zoomed in: the sides keep only what is wired to it
//
// Both are the same three columns; the selection below says which.
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
