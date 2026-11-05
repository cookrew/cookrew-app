import { activeBrowserTab, browserTabs, type BrowserNodeData } from '../../shared/model'

/**
 * THE SITES A BROWSER CARD HOLDS, AS ITS SEARCH RESULT SHOWS THEM (owner
 * 2026-11-03: "show the URL in the search results"). The row used to show the
 * showing tab as one line, "title — url", cut at the row's edge, so the
 * address was almost never readable, and a card's other sites not at all.
 *
 * Now each site is its own line pair: its page title, then its whole address.
 * The sites a search word lands on come first (the showing one first among
 * them), then the rest, up to `max`; the words are marked in both. Pure, so
 * the order and the marks are testable without a DOM.
 */

export interface Part {
  text: string
  mark: boolean
}

export interface SiteLine {
  id: string
  title: Part[]
  url: Part[]
  /** The tab the card is showing. */
  active: boolean
  /** A search word landed on this site. */
  hit: boolean
}

export interface SiteLines {
  lines: SiteLine[]
  /** Sites the row leaves out. */
  hidden: number
}

/** Sites a row shows before "+N more". */
export const SITES_SHOWN = 3

export function termsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** An address as a person reads it: %-escapes decoded where they decode. */
export function readableUrl(url: string): string {
  try {
    return decodeURI(url)
  } catch {
    return url
  }
}

/** `text` cut into runs, the runs that are a search word marked. Case-insensitive, longest word first. */
export function markParts(text: string, terms: readonly string[]): Part[] {
  if (!text) return []
  const lower = text.toLowerCase()
  const marked = new Array<boolean>(text.length).fill(false)
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) {
      for (let i = at; i < at + term.length; i++) marked[i] = true
    }
  }
  const parts: Part[] = []
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1]
    if (last && last.mark === marked[i]) parts[parts.length - 1] = { text: last.text + text[i], mark: last.mark }
    else parts.push({ text: text[i], mark: marked[i] })
  }
  return parts
}

export function siteLines(node: BrowserNodeData, query: string, max: number = SITES_SHOWN): SiteLines {
  const terms = termsOf(query)
  const activeId = activeBrowserTab(node).id
  const all = browserTabs(node).map((tab, order) => {
    const url = readableUrl(tab.url)
    const hay = `${tab.title}\n${url}\n${tab.url}`.toLowerCase()
    const line: SiteLine = {
      id: tab.id,
      title: markParts(tab.title, terms),
      url: markParts(url, terms),
      active: tab.id === activeId,
      hit: terms.some((t) => hay.includes(t)),
    }
    return { line, order }
  })
  const rank = ({ line }: { line: SiteLine }): number => (line.hit ? 0 : 2) + (line.active ? 0 : 1)
  const sorted = [...all].sort((a, b) => rank(a) - rank(b) || a.order - b.order).map((s) => s.line)
  return { lines: sorted.slice(0, max), hidden: Math.max(0, sorted.length - max) }
}
