import type { ItemHit } from './item-search'

/**
 * THE BOARD'S SEARCH RESULTS, BY KIND (owner 2026-11-01: browsers and notes
 * are searched too). Agents, browsers and notes are scored on different
 * scales, so they are not interleaved: each kind is its own section, in a
 * fixed order, and ALL shows the first few of each so a note that matches is
 * on screen next to the agents that do — it used to be listed after every
 * matching agent, below the fold. A kind chip, or a section's "all N" row,
 * shows one kind whole. Pure, so the layout is testable without a DOM.
 */

export type BoardKind = 'all' | 'agent' | 'browser' | 'note'
export type ItemKind = Exclude<BoardKind, 'all'>

export const KIND_ORDER: readonly ItemKind[] = ['agent', 'browser', 'note']

/** Rows each kind shows under ALL before its "all N" row. */
export const SECTION_CAP = 5

export const KIND_WORDS: Record<ItemKind, { one: string; many: string }> = {
  agent: { one: 'agent', many: 'agents' },
  browser: { one: 'browser', many: 'browsers' },
  note: { one: 'note', many: 'notes' },
}

export type SearchEntry<A> =
  | { kind: 'head'; of: ItemKind; count: number }
  | { kind: 'agent'; row: A }
  | { kind: 'element'; hit: ItemHit }
  | { kind: 'more'; of: ItemKind; count: number; hidden: number }

export type KindCounts = Record<ItemKind, number>

export function kindCounts(agents: readonly unknown[], items: readonly ItemHit[]): KindCounts {
  let browser = 0
  let note = 0
  for (const hit of items) {
    if (hit.node.kind === 'browser') browser += 1
    else note += 1
  }
  return { agent: agents.length, browser, note }
}

export function searchEntries<A>(
  agents: readonly A[],
  items: readonly ItemHit[],
  kind: BoardKind,
  cap: number = SECTION_CAP,
): SearchEntry<A>[] {
  const rowsOf = (of: ItemKind): SearchEntry<A>[] =>
    of === 'agent'
      ? agents.map((row) => ({ kind: 'agent' as const, row }))
      : items.filter((hit) => hit.node.kind === of).map((hit) => ({ kind: 'element' as const, hit }))
  if (kind !== 'all') return rowsOf(kind)
  const out: SearchEntry<A>[] = []
  for (const of of KIND_ORDER) {
    const rows = rowsOf(of)
    if (rows.length === 0) continue
    out.push({ kind: 'head', of, count: rows.length })
    out.push(...rows.slice(0, cap))
    if (rows.length > cap) out.push({ kind: 'more', of, count: rows.length, hidden: rows.length - cap })
  }
  return out
}

/** "1 agent · 3 notes" — only the kinds that found something. */
export function foundWords(counts: KindCounts): string {
  const parts = KIND_ORDER.filter((k) => counts[k] > 0).map(
    (k) => `${counts[k]} ${counts[k] === 1 ? KIND_WORDS[k].one : KIND_WORDS[k].many}`,
  )
  return parts.length > 0 ? parts.join(' · ') : 'nothing found'
}
