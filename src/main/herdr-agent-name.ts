/**
 * HERDR'S OWN NAME FOR AN AGENT (owner, 2026-11-02): it follows the card's.
 *
 * herdr names agents separately from the pane title Cookrew already reports
 * (`herdr agent rename`): the name is an address `herdr agent get|prompt|wait`
 * resolve, so it is a slug — `[a-z][a-z0-9_-]{0,31}` — and unique among the
 * server's live agents. A card's name is read into that slug; a card named
 * only in characters it cannot hold (a Chinese name) has none, and herdr's
 * is cleared rather than left wearing a name the card gave up.
 */

/** What herdr accepts as an agent name (herdr --skill, 0.9.0). */
export const HERDR_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/u

const MAX = 32

const fit = (slug: string, max: number): string => slug.slice(0, max).replace(/-+$/u, '')

export function herdrAgentName(cardName: string): string | null {
  const slug = cardName
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (slug === '') return null
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
