/**
 * ONE MODEL LIST (owner 2026-11-04: merge the two rows; keep the effort).
 *
 * A routed claude card's model IS its route (main/claude-model-route.ts), so
 * the tune chip had two rows saying one thing — MDL `opus` and RTE
 * `claude-opus-5-5` — and the new agent's chip, built before routes, had
 * neither the route nor the truth about what the default route would run.
 * Both chips now offer this one list, in this order:
 *
 *   claude     the gateway's Claude models       claude/claude-opus-5-5 …
 *   group      the gateway's groups              group/smart …
 *   other      every other provider it serves    auto/gpt-6.1-sol …
 *   direct     no route, claude's own alias      direct · opus …
 *
 * A pick is one string: a gateway id (the card is routed there), `direct:<alias>`
 * (the card goes direct, `--model <alias>`), or a bare alias, which older
 * callers send and main still reads the way it did.
 *
 * EFFORT IS KEPT across a model change (owner: keep it): a model without an effort
 * pick ran at its own default, so opus → sonnet silently went high → medium.
 * The levels a model takes come from the gateway's catalog.
 *
 * Pure: both chips, main and the tests read it.
 */

import { EFFORT_LEVELS, MODEL_ALIASES, isEffortLevel, isModelAlias, modelAliasOf, type AgentTuning, type TuneAsk } from './agent-tuning'

export const DIRECT = 'direct'
const DIRECT_PREFIX = 'direct:'

export type ModelSection = 'claude' | 'group' | 'other' | 'direct'

export interface ModelRow {
  value: string
  label: string
  section: ModelSection
}

export const MODEL_SECTION_LABEL: Record<ModelSection, string> = {
  claude: 'CLAUDE',
  group: 'GROUPS',
  other: 'OTHER PROVIDERS',
  direct: 'DIRECT'
}

/** Gateway ids stay one shell word: they end up on a launch line. */
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*\/[A-Za-z0-9._:/@+-]+$/

/** The direct row for an alias. */
export function directValue(alias: string): string {
  return `${DIRECT_PREFIX}${alias}`
}

/**
 * The list, from main's route choices (`['direct', ...groups, ...models]`,
 * route-view.routeChoices) and the aliases claude takes.
 */
export function modelRows(routeChoices: readonly string[], aliases: readonly string[] = MODEL_ALIASES): ModelRow[] {
  const ids = routeChoices.filter((id) => id !== DIRECT && ROUTE_ID.test(id))
  const row = (section: ModelSection) => (id: string): ModelRow => ({ value: id, label: id, section })
  return [
    ...ids.filter((id) => id.startsWith('claude/')).map(row('claude')),
    ...ids.filter((id) => id.startsWith('group/')).map(row('group')),
    ...ids.filter((id) => !id.startsWith('claude/') && !id.startsWith('group/')).map(row('other')),
    ...aliases.map((alias): ModelRow => ({ value: directValue(alias), label: `direct · ${alias}`, section: 'direct' }))
  ]
}

export type ModelPick = { route: string; alias?: undefined } | { route: typeof DIRECT; alias: string } | { route?: undefined; alias: string }

/** What a pick means, or null for a value no list offers. */
export function parseModelPick(value: string): ModelPick | null {
  if (value.startsWith(DIRECT_PREFIX)) {
    const alias = value.slice(DIRECT_PREFIX.length)
    return isModelAlias(alias) ? { route: DIRECT, alias } : null
  }
  if (value.includes('/')) return ROUTE_ID.test(value) ? { route: value } : null
  return isModelAlias(value) ? { alias: value } : null
}

/** The row the card stands on: its route when routed, `direct · <alias of the reading>` when direct. */
export function currentModelValue(route: string | null | undefined, tuning: AgentTuning | null): string | null {
  if (route && route !== DIRECT) return route
  if (route !== DIRECT) return null
  const alias = tuning?.model ? modelAliasOf(tuning.model) : null
  return alias ? directValue(alias) : null
}

/** A short chip word: the id's last part, `direct · opus`, or the alias. */
export function modelChipText(value: string): string {
  const pick = parseModelPick(value)
  if (pick?.route === DIRECT) return `direct · ${pick.alias}`
  if (pick?.route) return value.slice(value.lastIndexOf('/') + 1) || value
  return value
}

function sameModel(asked: string, current: string | null): boolean {
  if (current === null) return false
  if (asked === current) return true
  // An older caller's bare alias: the same family counts.
  return isModelAlias(asked) && modelAliasOf(current.replace(DIRECT_PREFIX, '')) === asked
}

/**
 * The newest model ask as the chip should show it: pending until a reply
 * lands after it, then settled (null) if the card stands where it was asked
 * to, refused otherwise.
 */
export function modelAskState(
  asks: readonly TuneAsk[],
  current: string | null,
  tuning: AgentTuning | null
): { asked: string; outcome: 'pending' | 'refused' } | null {
  const ask = [...asks].reverse().find((a) => a.knob === 'model')
  if (!ask) return null
  const replied = tuning?.at != null && tuning.at > ask.at
  if (!replied) return { asked: ask.value, outcome: 'pending' }
  return sameModel(ask.value, current) ? null : { asked: ask.value, outcome: 'refused' }
}

/** The effort levels a model takes: its catalog row's, else claude's own. */
export function effortLevelsFor(value: string | null | undefined, models: readonly { id: string; levels: readonly string[] }[]): readonly string[] {
  const pick = value ? parseModelPick(value) : null
  const id = pick?.route && pick.route !== DIRECT ? pick.route : null
  const levels = id ? models.find((m) => m.id === id)?.levels.filter(isEffortLevel) ?? [] : []
  return levels.length > 0 ? levels : EFFORT_LEVELS
}

/** The effort to carry onto another model: kept when that model takes it, else none (its own default). */
export function keptEffort(effort: string | null | undefined, levels: readonly string[]): string | null {
  return effort && levels.includes(effort) ? effort : null
}
