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
/** The other machines' books (phase 6: zoom/remote-hitl.ts), by machine id, as read from or written to their keys. */
const others = new Map<string, SeenBook>()
/** Bumped at every write to any book: what a reader of several books keys its memo on. */
let version = 0
const listeners = new Set<() => void>()

const store = (key: string, next: SeenBook): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(next))
  } catch {
    // Private mode or a full store: this session still remembers.
  }
}

const told = (): void => {
  version += 1
  for (const listener of listeners) listener()
}

function set(next: SeenBook): void {
  if (next === book) return
  book = next
  store(keyNow(), next)
  told()
}

const current = (): SeenBook => (book ??= load())

// Another machine, another book: read again from its own key. The other
// machines' are read again too: the one entered is now the live book, and two
// copies of one book must never both be written.
registerScopeState('bar seen', () => {
  book = null
  others.clear()
  told()
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

const idOf = (machineId: string): string => machineId.toLowerCase()
/** The machine this page's live book is: its book is that one, never a second copy. */
const inScope = (machineId: string): boolean => machineScope().machineId === idOf(machineId)

const otherBook = (machineId: string): SeenBook => {
  const id = idOf(machineId)
  const held = others.get(id)
  if (held) return held
  let read = EMPTY_BOOK
  try {
    read = loadBook(window.localStorage, bookKeyFor(id))
  } catch {
    // No storage: an empty book, kept for this session.
  }
  others.set(id, read)
  return read
}

const setOther = (machineId: string, next: SeenBook): void => {
  const id = idOf(machineId)
  if (others.get(id) === next) return
  others.set(id, next)
  store(bookKeyFor(id), next)
  told()
}

const editBook = (machineId: string, edit: (at: SeenBook) => SeenBook): void => {
  if (inScope(machineId)) set(edit(current()))
  else setOther(machineId, edit(otherBook(machineId)))
}

/**
 * ANOTHER MACHINE'S BOOK, BY ITS ID (phase 6: the bar holds what an agent
 * changed on the account's other machines). Its times are that machine's clock
 * and its ids its cards, so it is kept under that machine's own key
 * (bookKeyFor), the same key a console inside that machine keeps; the machine
 * in scope is the live book itself.
 */
export const machineSeen = {
  get: (machineId: string): SeenBook => (inScope(machineId) ? current() : otherBook(machineId)),
  mark: (machineId: string, id: string, at: number): void => editBook(machineId, (held) => markSeen(held, id, at)),
  cutoff: (machineId: string, at: number): void => editBook(machineId, (held) => withCutoff(held, at)),
  prune: (machineId: string, keep: (id: string) => boolean): void => editBook(machineId, (held) => pruneBook(held, keep)),
  subscribe: barSeen.subscribe,
  /** Changes with any write to any book. */
  version: (): number => version
}

export function useSeenBook(): SeenBook {
  return useSyncExternalStore(barSeen.subscribe, current, () => EMPTY_BOOK)
}
