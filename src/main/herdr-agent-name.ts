/**
 * HERDR'S OWN NAME FOR AN AGENT (owner, 2026-11-02): it follows the card's.
 *
 * herdr names agents separately from the pane title Cookrew already reports
 * (`herdr agent rename`): the name is an address `herdr agent get|prompt|wait`
 * resolve, so it is a slug — `[a-z][a-z0-9_-]{0,31}` — and unique among the
 * server's live agents (herdr src/app/agents.rs valid_agent_name, ASCII by
 * construction; the NAME herdr's panel shows is display_agent, which takes
 * the card's name as it is — pane-bindings.ts).
 *
 * A card's name is read into that slug, Chinese as toneless pinyin (one run
 * of characters, one word, the way it is typed: a six-character name reads
 * as dinglanmoxingqiehuan). A name with nothing readable at all (emoji, kana) falls back to
 * `card-<id>`, so every agent still has an address.
 */
import { pinyin } from 'pinyin-pro'

/** What herdr accepts as an agent name (herdr --skill, 0.9.0). */
export const HERDR_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/u

const MAX = 32

const fit = (slug: string, max: number): string => slug.slice(0, max).replace(/-+$/u, '')

/** Each run of Han characters as its toneless pinyin, set off as one word. */
const romanize = (text: string): string =>
  text.replace(/\p{Script=Han}+/gu, (run) => ` ${pinyin(run, { toneType: 'none', type: 'array' }).join('')} `)

/** `card-` and the first 8 letters/digits of the card's id. */
const idName = (id: string): string | null => {
  const tail = id.toLowerCase().replace(/[^a-z0-9]+/gu, '').slice(0, 8)
  return tail === '' ? null : `card-${tail}`
}

export function herdrAgentName(cardName: string, cardId?: string): string | null {
  const slug = romanize(cardName)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (slug === '') return cardId === undefined ? null : idName(cardId)
  return fit(/^[a-z]/u.test(slug) ? slug : `agent-${slug}`, MAX)
}

/** The name, or the first `name-N` no other live agent wears. */
export function uniqueHerdrAgentName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const next = `${fit(base, MAX - suffix.length)}${suffix}`
    if (!taken.has(next)) return next
  }
}

/** Is `name` the base, or the base with a -N suffix as uniqueHerdrAgentName cuts it? */
function wears(name: string, base: string): boolean {
  if (name === base) return true
  const suffix = name.match(/-\d+$/u)?.[0]
  return suffix !== undefined && name === `${fit(base, MAX - suffix.length)}${suffix}`
}

/** An agent as `herdr agent list` reports it. Only the fields read here. */
export interface ListedAgent {
  pane_id?: string
  name?: string | null
  /** The pane title: for a Cookrew pane, the card's name (reportPaneCard). */
  title?: string | null
  tokens?: Record<string, string> | null
}

/** A pane's agent and the name it should wear; null clears it. */
export interface AgentNameChange {
  paneId: string
  card: string
  name: string | null
}

export interface AgentNamePlan {
  /** Panes already wearing a fitting name: remembered, not renamed. */
  keep: AgentNameChange[]
  rename: AgentNameChange[]
}

/**
 * What every Cookrew pane's herdr name should be, from one `agent list`.
 * A pane keeps a name that already fits its card (the slug, or the slug with
 * a -N suffix it won earlier); the rest get the name they were last given,
 * or the slug, made unique against every name that stays.
 */
export function planAgentNames(
  agents: readonly ListedAgent[],
  given: ReadonlyMap<string, { card: string; name: string }>
): AgentNamePlan {
  const ours = agents.filter(
    (a): a is ListedAgent & { pane_id: string; title: string } =>
      typeof a.pane_id === 'string' &&
      typeof a.tokens?.cookrew_terminal === 'string' &&
      typeof a.title === 'string' &&
      a.title.trim() !== ''
  )
  const ourPanes = new Set(ours.map((a) => a.pane_id))
  const taken = new Set(
    agents.filter((a) => !ourPanes.has(a.pane_id ?? '') && typeof a.name === 'string').map((a) => a.name as string)
  )
  const keep: AgentNameChange[] = []
  const wanting: { paneId: string; card: string; base: string; want: string }[] = []
  const rename: AgentNameChange[] = []
  for (const agent of ours) {
    const card = agent.title
    const base = herdrAgentName(card, agent.tokens?.cookrew_terminal)
    const current = typeof agent.name === 'string' ? agent.name : null
    if (base === null) {
      if (current !== null) rename.push({ paneId: agent.pane_id, card, name: null })
      continue
    }
    const fits = current !== null && wears(current, base)
    if (fits && !taken.has(current)) {
      taken.add(current)
      keep.push({ paneId: agent.pane_id, card, name: current })
      continue
    }
    const last = given.get(agent.pane_id)
    wanting.push({ paneId: agent.pane_id, card, base, want: last?.card === card ? last.name : base })
  }
  for (const { paneId, card, base, want } of wanting) {
    const name = taken.has(want) ? uniqueHerdrAgentName(base, taken) : want
    taken.add(name)
    rename.push({ paneId, card, name })
  }
  return { keep, rename }
}
