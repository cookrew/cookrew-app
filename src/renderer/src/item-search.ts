import { activeBrowserTab, browserTabs, type BrowserNodeData, type CanvasNode, type NoteNodeData } from '../../shared/model'

/**
 * Search the board's browsers and notes by anything you remember about them:
 * a note's name or a line of its body, a browser's page title, its site or
 * any of its tabs' addresses. Pure, like agent-search.ts, and scored the same
 * way — every term must land somewhere (AND), a whole-field hit outranks a
 * substring, and a name hit outranks a passing mention in a body.
 *
 * SCOPE: the LOADED workspace's cards, the only ones the renderer holds.
 *
 * COST: the corpus (every field, lowercased once) is built per workspace
 * state, not per keystroke; a keystroke is one `includes` per field per term.
 */

export type BoardItem = NoteNodeData | BrowserNodeData

/** Field weights. The name is what you call it; a body only mentions things. */
const WEIGHTS = {
  name: 100,
  title: 60,
  host: 50,
  url: 40,
  body: 10,
} as const

const EXACT_MULTIPLIER = 1.5

/** Characters kept before a hit in a snippet: enough to read, short enough that the hit shows. */
const SNIPPET_BEFORE = 28
const SNIPPET_AFTER = 160

interface Field {
  text: string
  lower: string
  weight: number
  /** The tab this field came from, for a browser; null for its name. */
  tab: number | null
  /** A note's body: a hit here is shown as the passage around it. */
  body: boolean
}

export interface ItemCorpus {
  node: BoardItem
  fields: Field[]
}

/** Why a card is in the results, when its row would not already say so. */
export interface ItemSnippet {
  pre: string
  hit: string
  post: string
}

export interface ItemHit {
  node: BoardItem
  score: number
  snippet: ItemSnippet | null
}

const field = (text: string, weight: number, tab: number | null = null, body = false): Field => ({
  text,
  lower: text.toLowerCase(),
  weight,
  tab,
  body,
})

function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname
    return host ? host.replace(/^www\./, '') : null
  } catch {
    return null
  }
}

function fieldsOf(node: BoardItem): Field[] {
  const fields: Field[] = [field(node.name, WEIGHTS.name)]
  if (node.kind === 'note') {
    if (node.customName && node.customName !== node.name) fields.push(field(node.customName, WEIGHTS.name))
    if (node.content) fields.push(field(node.content, WEIGHTS.body, null, true))
    return fields
  }
  browserTabs(node).forEach((tab, i) => {
    if (tab.title) fields.push(field(tab.title, WEIGHTS.title, i))
    const host = hostOf(tab.url)
    if (host) fields.push(field(host, WEIGHTS.host, i))
    if (tab.url) fields.push(field(tab.url, WEIGHTS.url, i))
  })
  return fields
}

/** The board's notes and browsers, ready to search. Build once per workspace state. */
export function itemCorpus(nodes: readonly CanvasNode[]): ItemCorpus[] {
  const out: ItemCorpus[] = []
  for (const node of nodes) if (node.kind !== 'terminal') out.push({ node, fields: fieldsOf(node) })
  return out
}

interface TermHit {
  score: number
  field: Field
  at: number
}

function scoreTerm(fields: Field[], term: string): TermHit | null {
  let best: TermHit | null = null
  for (const f of fields) {
    const at = f.lower.indexOf(term)
    if (at < 0) continue
    const score = f.lower === term ? f.weight * EXACT_MULTIPLIER : f.weight
    if (best === null || score > best.score) best = { score, field: f, at }
  }
  return best
}

const flat = (text: string): string => text.replace(/\s+/g, ' ')

/** The passage around a hit in a note's body, cut on whole characters. */
function passage(f: Field, at: number, length: number): ItemSnippet {
  const start = Math.max(0, at - SNIPPET_BEFORE)
  const end = Math.min(f.text.length, at + length + SNIPPET_AFTER)
  return {
    pre: (start > 0 ? '…' : '') + flat(f.text.slice(start, at)).trimStart(),
    hit: f.text.slice(at, at + length),
    post: flat(f.text.slice(at + length, end)).trimEnd() + (end < f.text.length ? '…' : ''),
  }
}

/**
 * What to show for the best hit, or null when the row already shows it: a
 * name is the row's title, and the active tab's title and address are its
 * address line. A note's body gets its passage; another tab gets its line.
 */
function snippetOf(node: BoardItem, best: TermHit, term: string): ItemSnippet | null {
  const f = best.field
  if (f.body) return passage(f, best.at, term.length)
  if (node.kind !== 'browser' || f.tab === null) return null
  const tabs = browserTabs(node)
  const tab = tabs[f.tab]
  if (!tab || tab.id === activeBrowserTab(node).id) return null
  const line = tab.title ? `${tab.title} — ${tab.url}` : tab.url
  const at = line.toLowerCase().indexOf(term)
  return at < 0
    ? { pre: `${line}`, hit: '', post: '' }
    : { pre: line.slice(0, at), hit: line.slice(at, at + term.length), post: line.slice(at + term.length) }
}

/** Filter and rank; ties keep the board's own order. */
export function searchItems(corpus: readonly ItemCorpus[], query: string): ItemHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return corpus.map(({ node }) => ({ node, score: 0, snippet: null }))
  const scored: (ItemHit & { order: number })[] = []
  corpus.forEach(({ node, fields }, order) => {
    let total = 0
    // The snippet follows the term that landed in the weakest field: that is
    // the one the row would otherwise give no reason for.
    let shown: { hit: TermHit; term: string } | null = null
    for (const term of terms) {
      const hit = scoreTerm(fields, term)
      if (hit === null) return
      total += hit.score
      if (shown === null || hit.field.weight < shown.hit.field.weight) shown = { hit, term }
    }
    scored.push({ node, score: total, order, snippet: shown ? snippetOf(node, shown.hit, shown.term) : null })
  })
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map(({ node, score, snippet }) => ({ node, score, snippet }))
}
