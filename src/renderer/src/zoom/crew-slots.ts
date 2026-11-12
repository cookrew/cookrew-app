import type { Pos } from './zoom-layout'

/**
 * WHERE AN AGENT STANDS IN THE CREW, BY HAND (owner 2026-11-12: "swap places
 * to change how the prism is worked out"). The crew is laid out by its ties
 * (zoom-layout.ts · crewRows); a drag of one face onto another swaps their
 * places, and the ties, the fold and its faces are worked out from where they
 * now stand. Kept on this device, per workspace, as which agent stands in
 * whose laid-out place: an agent added later takes its own place, and one
 * that has gone leaves its swap behind without a gap.
 */

export type Slots = Readonly<Record<string, string>>

const KEY = 'cookrew.crew-slots'
const listeners = new Set<() => void>()

const readAll = (): Record<string, Record<string, string>> => {
  try {
    const kept = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') as unknown
    return kept && typeof kept === 'object' ? (kept as Record<string, Record<string, string>>) : {}
  } catch {
    return {}
  }
}

/** The swaps as they stand: read once, then kept here as well, so a page that cannot store them still holds them. */
let kept = readAll()

/** No swaps: one object, so a crew with none is never laid out again for it. */
const NONE: Slots = Object.freeze({})

export const slotsOf = (workspace: string): Slots => kept[workspace] ?? NONE

/**
 * The places the laid-out crew becomes: each agent at the place its slot names
 * when both are here, the rest at their own, and an agent whose own place a
 * swap has taken (its partner gone) at a place left free. One agent a place.
 */
export function withSlots(at: Readonly<Record<string, Pos>>, slots: Slots): Record<string, Pos> {
  const ids = Object.keys(at)
  const place = new Map<string, string>()
  const used = new Set<string>()
  for (const [id, slot] of Object.entries(slots)) {
    if (!at[id] || !at[slot] || used.has(slot) || place.has(id)) continue
    place.set(id, slot)
    used.add(slot)
  }
  for (const id of ids) {
    if (place.has(id) || used.has(id)) continue
    place.set(id, id)
    used.add(id)
  }
  const free = ids.filter((id) => !used.has(id))
  for (const id of ids) if (!place.has(id)) place.set(id, free.shift() ?? id)
  return Object.fromEntries(ids.map((id) => [id, at[place.get(id) ?? id]]))
}

/** Swaps where two agents stand, from wherever they stand now. */
export function swapped(slots: Slots, a: string, b: string): Record<string, string> {
  const next: Record<string, string> = { ...slots }
  const sa = slots[a] ?? a
  const sb = slots[b] ?? b
  if (sb === a) delete next[a]
  else next[a] = sb
  if (sa === b) delete next[b]
  else next[b] = sa
  return next
}

export function swapSlots(workspace: string, a: string, b: string): void {
  if (a === b) return
  kept = { ...kept, [workspace]: swapped(kept[workspace] ?? {}, a, b) }
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(kept))
  } catch {
    // Private mode: it holds for this page.
  }
  listeners.forEach((listener) => listener())
}

export const subscribeSlots = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
