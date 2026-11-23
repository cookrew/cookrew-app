import type { MirrorBlock } from '../../../shared/dom-mirror'

/** One thing the view draws: a block alone, or a run of list items under one list. */
export type MirrorRow =
  | { readonly kind: 'one'; readonly block: MirrorBlock }
  | { readonly kind: 'list'; readonly key: number; readonly items: readonly MirrorBlock[] }

/** Blocks in reading order as rows: consecutive list items share one list, so the markup stays valid. */
export function mirrorRows(blocks: readonly MirrorBlock[]): MirrorRow[] {
  return blocks.reduce<MirrorRow[]>((rows, block) => {
    const last = rows[rows.length - 1]
    if (block.role !== 'listitem') return [...rows, { kind: 'one', block }]
    if (last?.kind === 'list') return [...rows.slice(0, -1), { ...last, items: [...last.items, block] }]
    return [...rows, { kind: 'list', key: block.ref, items: [block] }]
  }, [])
}

/** A heading's level as a tag the view may use: h2..h6 (the card's own title is the page's h1). */
export function headingTag(level: number | undefined): 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
  const n = Math.min(Math.max((level ?? 2) + 1, 2), 6)
  return `h${n}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
}

/** Where a link goes, said short: its host, or the address as given when it has none. */
export function linkHint(href: string | undefined): string | null {
  if (href === undefined) return null
  try {
    return new URL(href).host || href
  } catch {
    return href.length > 60 ? `${href.slice(0, 60)}…` : href
  }
}
