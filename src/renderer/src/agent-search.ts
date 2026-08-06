import type { AgentRow } from './agent-rows'

/**
 * Search the crew by anything you remember about them — who they are, or what
 * was said. Pure, so the ranking is testable without a DOM.
 *
 * SCOPE, stated plainly because the UI must not overclaim: the corpus is what
 * the renderer already holds — every agent's identity everywhere, but only the
 * LOADED workspace's conversations, because that is the only place live turn
 * state exists. The event log cannot help: it is metadata-only by design
 * (main/event-log.ts: "events carry METADATA ONLY — never prompt/reply text").
 *
 * Widening it to every workspace's full history needs a main-process search
 * over the turn ledger. When that lands, only `searchCorpus` changes.
 */

/** Field weights. A name hit beats a passing mention in a reply. */
const WEIGHTS = {
  name: 100,
  role: 60,
  preset: 50,
  workspace: 40,
  title: 30,
  tool: 20,
  ask: 15,
  latest: 10,
} as const

/**
 * A whole-field hit outranks a substring of a longer one ("Forge" beats
 * "Forgemaster"). Proportional, not flat: a flat bonus let an exact hit in a
 * low-weight field outrank a partial hit in a high-weight one, so a reply that
 * merely said "sidebar" beat a recap titled "sidebar work".
 */
const EXACT_MULTIPLIER = 1.5

interface Field {
  text: string
  weight: number
}

function fieldsOf(row: AgentRow): Field[] {
  const fields: Field[] = [
    { text: row.name, weight: WEIGHTS.name },
    { text: row.preset, weight: WEIGHTS.preset },
    { text: row.workspaceName, weight: WEIGHTS.workspace },
  ]
  if (row.role) fields.push({ text: row.role, weight: WEIGHTS.role })
  const turn = row.turn
  if (turn) {
    if (turn.title) fields.push({ text: turn.title, weight: WEIGHTS.title })
    if (turn.ask) fields.push({ text: turn.ask, weight: WEIGHTS.ask })
    if (turn.latest) fields.push({ text: turn.latest.text, weight: WEIGHTS.latest })
    if (turn.tail) fields.push({ text: turn.tail, weight: WEIGHTS.latest })
    for (const tool of turn.tools) fields.push({ text: tool, weight: WEIGHTS.tool })
  }
  return fields
}

/**
 * Everything a row can be found by, as one string. The ONE place that decides
 * what is searchable — widen the corpus here and search widens everywhere.
 */
export function searchCorpus(row: AgentRow): string {
  return fieldsOf(row)
    .map((f) => f.text)
    .join(' ')
}

/** Best score this term earns on this row, or null when it appears nowhere. */
function scoreTerm(fields: Field[], term: string): number | null {
  let best: number | null = null
  for (const field of fields) {
    const text = field.text.toLowerCase()
    if (!text.includes(term)) continue
    const score = text === term ? field.weight * EXACT_MULTIPLIER : field.weight
    if (best === null || score > best) best = score
  }
  return best
}

/**
 * Filter and rank. Every term must appear somewhere on the row (AND), though
 * different terms may land in different fields — "forge sampler" finds Forge by
 * name and by what it was asked.
 *
 * Ties keep the order they came in, which is the activity ranking: search
 * refines the list, it does not reshuffle it.
 */
export function searchAgents(rows: AgentRow[], query: string): AgentRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return rows

  const scored: { row: AgentRow; score: number; at: number }[] = []
  rows.forEach((row, at) => {
    const fields = fieldsOf(row)
    let total = 0
    for (const term of terms) {
      const score = scoreTerm(fields, term)
      if (score === null) return
      total += score
    }
    scored.push({ row, score: total, at })
  })

  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((s) => s.row)
}
