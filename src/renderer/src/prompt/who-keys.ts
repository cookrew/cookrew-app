/**
 * THE WHO-PICKER'S KEYS AND FILTER (design cut "Who-picker keyboard & filter",
 * 2026-11-04): the desktop list over the chip has a 'Send to…' field at its
 * top. Typing filters agents and harnesses by name; ↑ ↓ move through one
 * order (who waits, the recent, a new agent on each harness); ⏎ picks; Esc
 * closes. Pure rules, drawn by WhoPicker.tsx.
 */

const fold = (s: string): string => s.normalize('NFKC').toLocaleLowerCase()

/**
 * How well a name answers what was typed: 0 at its start, 1 at a word's
 * start, 2 inside it, null not at all. Nothing typed answers every name.
 */
export function whoMatch(name: string, query: string): number | null {
  const q = fold(query.trim())
  if (q === '') return 0
  const n = fold(name)
  const at = n.indexOf(q)
  if (at < 0) return null
  if (at === 0) return 0
  return n.split(/[\s·_\-/]+/).some((word) => word.startsWith(q)) ? 1 : 2
}

/** The rows that answer, best first, their order kept among equals (it is the activity order). */
export function whoFilter<T>(rows: readonly T[], query: string, nameOf: (row: T) => string): T[] {
  return rows
    .map((row, i) => ({ row, i, score: whoMatch(nameOf(row), query) }))
    .filter((x): x is { row: T; i: number; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((x) => x.row)
}

/** One row's key in the picker: an agent's, or a new agent's on a harness. */
export const agentKey = (id: string): string => `agent:${id}`
export const newKey = (harness: string): string => `new:${harness}`

/** The order ↑ ↓ move through: who waits, then the recent, then a new agent on each harness. */
export function whoKeys(
  lists: { readonly waiting: readonly { readonly id: string }[]; readonly recent: readonly { readonly id: string }[] },
  harnesses: readonly string[]
): string[] {
  return [...lists.waiting.map((a) => agentKey(a.id)), ...lists.recent.map((a) => agentKey(a.id)), ...harnesses.map(newKey)]
}

/** Where ⏎ points as the list opens or the filter changes: the first row not already in the box. */
export function whoStart(keys: readonly string[], current: string | null): string | null {
  return keys.find((k) => k !== current) ?? keys[0] ?? null
}

/** One row on, round from the ends; from nowhere, ↓ is the first row and ↑ the last. */
export function whoStep(keys: readonly string[], active: string | null, delta: 1 | -1): string | null {
  if (keys.length === 0) return null
  const at = active === null ? -1 : keys.indexOf(active)
  if (at < 0) return delta > 0 ? keys[0] : keys[keys.length - 1]
  return keys[(at + delta + keys.length) % keys.length]
}

/**
 * The scroll that shows a row [start, start + size) in a view `view` long now
 * scrolled to `scroll`: the least move, none when it already shows.
 */
export function revealAt(scroll: number, view: number, start: number, size: number): number {
  if (start < scroll) return start
  if (start + size > scroll + view) return start + size - view
  return scroll
}
