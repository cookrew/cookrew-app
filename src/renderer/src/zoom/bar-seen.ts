import { useSyncExternalStore } from 'react'
import { activeBrowserTab, type CanvasNode } from '../../../shared/model'

/**
 * SINCE YOU LAST LOOKED (owner, 2026-11-04: the bar's groups are the
 * human-in-the-loop inbox, BarGroups.tsx). Per workspace, what each browser or
 * note was when you last looked at it (its card or its full view opened), and
 * when a change to it was first noticed. Kept in localStorage, so a reload or
 * a restart does not hand everything back. An agent's reply is not in here:
 * whether it is read is the tracker's, the same on every device (bar-inbox.ts).
 *
 * The board keeps no change times, and a node is replaced, never edited, when
 * it changes (zoom-model.ts), so "what it is now" is its signature: a
 * browser's address, a note's words. The first look at a workspace is the
 * baseline: what is there already is not news (300 browsers on the owner's
 * board would otherwise all be "new" at once).
 */

export interface SeenPage {
  /** The workspace was looked at once: what it held then is the baseline. */
  readonly based: boolean
  /** id → its signature when you last looked. */
  readonly seen: Readonly<Record<string, string>>
  /** id → [the signature not looked at yet, when it was first noticed]. */
  readonly noticed: Readonly<Record<string, readonly [string, number]>>
}

export type SeenBook = Readonly<Record<string, SeenPage>>

export const EMPTY_PAGE: SeenPage = Object.freeze({ based: false, seen: Object.freeze({}), noticed: Object.freeze({}) })

/** Pages past this many ids drop the ones the board no longer has, so the store stays small. */
const PRUNE_AT = 4000

/** A short, stable hash of a string (djb2), in base 36. */
function hashOf(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** What a browser or note is now: its address or its words, hashed; null for anything else. */
export function itemSig(node: CanvasNode): string | null {
  if (node.kind === 'browser') return `b${hashOf(activeBrowserTab(node).url ?? '')}`
  if (node.kind === 'note') return `n${hashOf(node.content ?? '')}`
  return null
}

export const pageOf = (book: SeenBook, workspace: string): SeenPage => book[workspace] ?? EMPTY_PAGE

/** Not looked at as it is now. Before the baseline nothing is news. */
export const isUnseen = (page: SeenPage, id: string, sig: string): boolean => page.based && page.seen[id] !== sig

/**
 * A look at the workspace's browsers and notes: the first one sets the
 * baseline; after it, each one changed since you looked is noticed (once, at
 * the time it was first seen so). The same book back when nothing is news.
 */
export function observe(book: SeenBook, workspace: string, items: readonly { readonly id: string; readonly sig: string }[], now: number): SeenBook {
  const page = pageOf(book, workspace)
  if (!page.based) {
    if (items.length === 0) return book
    return { ...book, [workspace]: { based: true, seen: Object.fromEntries(items.map((i) => [i.id, i.sig])), noticed: {} } }
  }
  const fresh = items.filter((i) => page.seen[i.id] !== i.sig && page.noticed[i.id]?.[0] !== i.sig)
  const here = new Set(items.map((i) => i.id))
  const gone = Object.keys(page.noticed).some((id) => !here.has(id))
  const big = Object.keys(page.seen).length > PRUNE_AT
  if (fresh.length === 0 && !gone && !big) return book
  // What is noticed is only ever an item on the board: one deleted unseen goes with it.
  const noticed = Object.fromEntries(
    [...Object.entries(page.noticed), ...fresh.map((i) => [i.id, [i.sig, now] as const] as const)].filter(([id]) => here.has(id))
  )
  const seen = big ? Object.fromEntries(Object.entries(page.seen).filter(([id]) => here.has(id))) : page.seen
  return { ...book, [workspace]: { based: true, seen, noticed } }
}

/** Looked at (its card or full view opened): it is what it is now, and no longer news. */
export function markSeen(book: SeenBook, workspace: string, id: string, sig: string): SeenBook {
  const page = pageOf(book, workspace)
  if (page.seen[id] === sig && page.noticed[id] === undefined) return book
  const noticed = Object.fromEntries(Object.entries(page.noticed).filter(([key]) => key !== id))
  return { ...book, [workspace]: { based: page.based, seen: { ...page.seen, [id]: sig }, noticed } }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The stored book; anything unreadable is an empty one. */
export function readBook(raw: string | null): SeenBook {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    const out: Record<string, SeenPage> = {}
    for (const [ws, page] of Object.entries(parsed)) {
      if (!isRecord(page) || !isRecord(page.seen) || !isRecord(page.noticed)) continue
      const seen = Object.fromEntries(Object.entries(page.seen).filter((e): e is [string, string] => typeof e[1] === 'string'))
      const noticed = Object.fromEntries(
        Object.entries(page.noticed).filter((e): e is [string, [string, number]] => Array.isArray(e[1]) && typeof e[1][0] === 'string' && typeof e[1][1] === 'number')
      )
      out[ws] = { based: page.based === true, seen, noticed }
    }
    return out
  } catch {
    return {}
  }
}

const KEY = 'cookrew.bar-seen'

const load = (): SeenBook => {
  try {
    return readBook(window.localStorage.getItem(KEY))
  } catch {
    return {}
  }
}

let book: SeenBook | null = null
const listeners = new Set<() => void>()

function set(next: SeenBook): void {
  if (next === book) return
  book = next
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Private mode or a full store: this session still remembers.
  }
  for (const listener of listeners) listener()
}

const current = (): SeenBook => (book ??= load())

/** The one book the app reads and writes (BarGroups.tsx). */
export const barSeen = {
  get: current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  observe: (workspace: string, items: readonly { readonly id: string; readonly sig: string }[], now = Date.now()): void => set(observe(current(), workspace, items, now)),
  mark: (workspace: string, id: string, sig: string): void => set(markSeen(current(), workspace, id, sig))
}

export function useSeenPage(workspace: string | null): SeenPage {
  return useSyncExternalStore(barSeen.subscribe, () => (workspace ? pageOf(current(), workspace) : EMPTY_PAGE), () => EMPTY_PAGE)
}
