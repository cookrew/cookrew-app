import { useSyncExternalStore } from 'react'
import { machineScope, registerScopeState } from '../machine-scope'

/**
 * SINCE YOU LAST LOOKED, v2 (owner, 2026-11-16; plan
 * docs/hitl-cross-workspace-2026-11-15 · v6.2). An artifact is news when an
 * AGENT changed it after you last looked (hitl-artifacts.ts reads that off the
 * activity log), so the book holds, per card, the time of the agent change you
 * last saw, and the starting point the first boot set: what the log held then
 * is not news. Both are times the main process stamped, never this device's
 * clock. Each device keeps its own book; a reply's read state is the tracker's,
 * the same everywhere (bar-inbox.ts).
 *
 * v1 kept a hash of each card's words or address, so the owner's own edits and
 * tab switches came back as news; it is forgotten on first load.
 */

export interface SeenBook {
  /** Changes at or before this are not news; null until the first boot read sets it. */
  readonly cutoff: number | null
  /** card id → the agent change last looked at. */
  readonly seen: Readonly<Record<string, number>>
}

export const EMPTY_BOOK: SeenBook = Object.freeze({ cutoff: null, seen: Object.freeze({}) })

export const BOOK_KEY = 'cookrew.bar-seen.v2'
export const OLD_BOOK_KEY = 'cookrew.bar-seen'

/**
 * The book is ONE machine's: its times are that machine's clock and its ids its
 * cards. This page's own machine keeps the plain key; a console inside another
 * machine keeps one per machine.
 */
export const bookKeyFor = (machineId: string | null): string => (machineId === null ? BOOK_KEY : `${BOOK_KEY}:${machineId}`)
/** Past this many cards, the ones no longer artifacts are dropped. */
const PRUNE_AT = 2000

/** Looked at this change: the book only ever moves forward. The same book when it does not. */
export function markSeen(book: SeenBook, id: string, at: number): SeenBook {
  if ((book.seen[id] ?? Number.NEGATIVE_INFINITY) >= at) return book
  return { ...book, seen: { ...book.seen, [id]: at } }
}

/** The starting point, set once. */
export function withCutoff(book: SeenBook, at: number): SeenBook {
  return book.cutoff === null ? { ...book, cutoff: at } : book
}

/** A big book keeps only the cards still artifacts. */
export function pruneBook(book: SeenBook, keep: (id: string) => boolean): SeenBook {
  if (Object.keys(book.seen).length <= PRUNE_AT) return book
  return { ...book, seen: Object.fromEntries(Object.entries(book.seen).filter(([id]) => keep(id))) }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The stored book; anything unreadable is an empty one. */
export function readBook(raw: string | null): SeenBook {
  if (!raw) return EMPTY_BOOK
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return EMPTY_BOOK
    const cutoff = typeof parsed.cutoff === 'number' && Number.isFinite(parsed.cutoff) ? parsed.cutoff : null
    const seen = isRecord(parsed.seen)
      ? Object.fromEntries(Object.entries(parsed.seen).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])))
      : {}
    return { cutoff, seen }
  } catch {
    return EMPTY_BOOK
  }
}

/** The book a store holds under `key`; the v1 book goes on the way (its hashes count the owner's own edits). */
export function loadBook(storage: Pick<Storage, 'getItem' | 'removeItem'>, key: string): SeenBook {
  try {
    storage.removeItem(OLD_BOOK_KEY)
    return readBook(storage.getItem(key))
  } catch {
    return EMPTY_BOOK
  }
}

const keyNow = (): string => bookKeyFor(machineScope().machineId)

const load = (): SeenBook => {
  try {
    return loadBook(window.localStorage, keyNow())
  } catch {
    return EMPTY_BOOK
  }
}

let book: SeenBook | null = null
const listeners = new Set<() => void>()

function set(next: SeenBook): void {
  if (next === book) return
  book = next
  try {
    window.localStorage.setItem(keyNow(), JSON.stringify(next))
  } catch {
    // Private mode or a full store: this session still remembers.
  }
  for (const listener of listeners) listener()
}

const current = (): SeenBook => (book ??= load())

// Another machine, another book: read again from its own key.
registerScopeState('bar seen', () => {
  book = null
  for (const listener of listeners) listener()
})

/** The one book the app reads and writes (BarGroups.tsx, hitl-artifacts.ts). */
export const barSeen = {
  get: current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  mark: (id: string, at: number): void => set(markSeen(current(), id, at)),
  cutoff: (at: number): void => set(withCutoff(current(), at)),
  prune: (keep: (id: string) => boolean): void => set(pruneBook(current(), keep))
}

export function useSeenBook(): SeenBook {
  return useSyncExternalStore(barSeen.subscribe, current, () => EMPTY_BOOK)
}
