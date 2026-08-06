import type { TurnRecord } from './turn'

/**
 * Search an agent's checkpoints. Runs in MAIN over the whole turn ledger
 * (~/.cookrew/turns/*.json — 3.2 MB of text across ~1,500 turns on a working
 * machine), because that is the only corpus that is both cross-workspace and
 * small enough to scan on a keystroke. The event log carries no conversation
 * text by design, and the harness transcripts are ~2 GB.
 *
 * A match returns METADATA AND A SNIPPET, never the turn body. Whole replies
 * must not cross the wire to draw one line — the same rule that made the board
 * ship a summary instead of a prompt.
 */

/** Characters of context either side of the hit. */
const SNIPPET_PAD = 60
/** Hard cap on a snippet, so one enormous turn cannot dominate a response. */
const SNIPPET_MAX = 180

export type TurnMatchField = 'title' | 'prompt' | 'reply'

export interface TurnMatch {
  terminalId: string
  /** Checkpoint ordinal — what the rail's goto() takes. */
  turnIndex: number
  /** Where the strongest hit landed. */
  field: TurnMatchField
  /** Human label for the result row: the Sous recap when there is one. */
  title: string
  /** Text around the hit, ellipsed. Never the whole turn. */
  snippet: string
  endedAt: number
  score: number
}

/** A recap hit beats the ask, which beats a passing mention in the reply. */
const FIELD_WEIGHT: Record<TurnMatchField, number> = { title: 30, prompt: 20, reply: 10 }

/** Collapse whitespace so a snippet is one readable line. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Squashed (whitespace-free) form of a field, plus where each char came from. */
interface Squashed {
  text: string
  origin: number[]
}

const isSpace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11

/**
 * Built at most ONCE per field, not once per term, and with a charCode test
 * rather than a regex per character — the naive version cost 89ms per query on
 * a 1,462-turn ledger against 8ms for plain indexOf.
 */
function squash(lower: string): Squashed {
  const chars: string[] = []
  const origin: number[] = []
  for (let i = 0; i < lower.length; i++) {
    if (isSpace(lower.charCodeAt(i))) continue
    chars.push(lower[i])
    origin.push(i)
  }
  return { text: chars.join(''), origin }
}

/**
 * Find `term` in `lower`, ignoring whitespace differences, returning the
 * position in the ORIGINAL string. Measured on a real ledger, "homeassistant"
 * matched 6 turns where "home assistant" matched 27 — the same subject spelled
 * both ways, and the closed-up query missed 78% of its own history.
 *
 * `cache` holds the squashed form so repeated terms do not rebuild it.
 */
function indexIgnoringSpace(lower: string, term: string, cache: { value?: Squashed }): number {
  const direct = lower.indexOf(term)
  if (direct >= 0) return direct
  if (term.length === 0 || /\s/.test(term)) return -1

  const squashed = (cache.value ??= squash(lower))
  const at = squashed.text.indexOf(term)
  return at < 0 ? -1 : squashed.origin[at]
}

function snippetAround(text: string, at: number, term: string): string {
  const flat = flatten(text)
  // Re-find in the flattened text; the original index shifts when runs collapse.
  // Space-insensitive, so a hit that spanned a space still centres correctly.
  const index = indexIgnoringSpace(flat.toLowerCase(), term, {})
  const from = Math.max(0, (index < 0 ? at : index) - SNIPPET_PAD)
  const cut = flat.slice(from, from + SNIPPET_MAX)
  return `${from > 0 ? '…' : ''}${cut}${from + SNIPPET_MAX < flat.length ? '…' : ''}`
}

/**
 * Every term must appear somewhere in the turn (AND), though different terms
 * may land in different fields. Scores by where each term's strongest hit was.
 *
 * Terms are lowercased here rather than trusted to arrive that way: this is
 * exported, and a caller passing "SIDEBAR" silently getting zero results would
 * be a trap.
 */
export function matchTurn(
  terminalId: string,
  record: TurnRecord,
  rawTerms: readonly string[],
): TurnMatch | null {
  const terms = rawTerms.map((t) => t.toLowerCase())
  const fields: [TurnMatchField, string][] = [
    ['title', record.title ?? ''],
    ['prompt', record.prompt ?? ''],
    ['reply', record.reply ?? ''],
  ]
  // One squash per field for the whole term loop, built only if a term misses.
  const lowered = fields.map(([, text]) => text.toLowerCase())
  const squashCache: { value?: Squashed }[] = fields.map(() => ({}))

  let score = 0
  let best: { field: TurnMatchField; at: number; term: string } | null = null

  for (const term of terms) {
    let termBest: { field: TurnMatchField; at: number; weight: number } | null = null
    for (let f = 0; f < fields.length; f++) {
      const [field, text] = fields[f]
      if (text === '') continue
      const at = indexIgnoringSpace(lowered[f], term, squashCache[f])
      if (at < 0) continue
      const weight = FIELD_WEIGHT[field]
      if (termBest === null || weight > termBest.weight) termBest = { field, at, weight }
    }
    // AND: a term found nowhere disqualifies the turn.
    if (termBest === null) return null
    score += termBest.weight
    if (best === null || termBest.weight > FIELD_WEIGHT[best.field]) {
      best = { field: termBest.field, at: termBest.at, term }
    }
  }

  if (best === null) return null
  const source = fields.find(([f]) => f === best.field)?.[1] ?? ''
  const title = record.title?.trim() || flatten(record.prompt ?? '').slice(0, 80) || '(empty turn)'

  return {
    terminalId,
    turnIndex: record.index,
    field: best.field,
    title,
    snippet: snippetAround(source, best.at, best.term),
    endedAt: record.endedAt,
    score,
  }
}

export interface TurnSearchInput {
  /** terminalId → that agent's checkpoints. */
  ledger: ReadonlyMap<string, readonly TurnRecord[]>
  query: string
  /** Newest-first cap on the response. */
  limit?: number
}

const DEFAULT_LIMIT = 50

/**
 * Rank checkpoint matches. Recency is a tiebreak rather than the primary key:
 * a recap hit from last week should still beat a passing mention from an hour
 * ago, but among equal hits the recent one wins.
 */
export function searchTurns(input: TurnSearchInput): TurnMatch[] {
  const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []

  const matches: TurnMatch[] = []
  for (const [terminalId, records] of input.ledger) {
    for (const record of records) {
      const match = matchTurn(terminalId, record, terms)
      if (match) matches.push(match)
    }
  }

  return matches
    .sort((a, b) => b.score - a.score || b.endedAt - a.endedAt)
    .slice(0, input.limit ?? DEFAULT_LIMIT)
}
