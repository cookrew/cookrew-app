// A CLAUDE MODEL PICK, WHEREVER THE CARD'S TURNS GO (QA 2026-11-03: "the model
// must follow the pick"; the owner: model and effort hang together with RTE).
//
// Claude resolves `--model sonnet` through ANTHROPIC_DEFAULT_SONNET_MODEL, and
// the `env` block of ~/.claude/settings.json outranks the env a process
// inherits. On a machine where Magpie wrote that block (every alias →
// `group/smart[1m]`), every alias pick landed on group/smart: on a direct card,
// and on a routed card too, where the flag also outranked the route the card
// shows. So the pick is spelled for where the turns go:
//
//   routed card   the model IS the route. A pick sets the route to the
//                 gateway's model for the alias (`sonnet` →
//                 `claude/claude-sonnet-5-5`), and the card carries no
//                 `--model` (the spawn strips one too: launch-tune
//                 withoutRoutedPick), so RTE and MDL can never disagree.
//   direct card   the pick stays `--model <alias>` on the card, the owner's
//                 intent. The spawn sends the gateway's id instead when
//                 claude's own settings point it at a gateway, where an alias
//                 means whatever that settings block says.
//
// Effort is a flag either way: `--effort` holds on a routed card as well.
// Pure: the catalog and the settings arrive as values.

import { EFFORT_LEVELS, isEffortLevel } from '../shared/agent-tuning'
import { launchCommand, withoutRoutedPick, type LaunchKnob, type LaunchOffer } from '../shared/launch-tune'
import { DIRECT, keptEffort, parseModelPick } from '../shared/model-pick'

/** What a pick changes on the card. */
export interface LaunchPatch {
  command: string
  /** Set when the pick moved the card's route (a routed card's model). */
  route?: string
}

export type LaunchPlan = LaunchPatch | { error: string }

/** The version numbers after `claude/claude-<alias>-`, or null for an id of another shape. */
function versionOf(id: string, prefix: string): number[] | null {
  if (!id.startsWith(prefix)) return null
  const parts = id.slice(prefix.length).split('-').map(Number)
  return parts.length > 0 && parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : null
}

/** Newer first: 5-5 over 5 over 4-8; a dated snapshot of a version sorts after the version itself. */
function newer(a: number[], b: number[]): boolean {
  const undated = (v: number[]): number[] => v.filter((n) => n < 10_000)
  const [x, y] = [undated(a), undated(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? -1) - (y[i] ?? -1)
    if (d !== 0) return d > 0
  }
  return a.length < b.length
}

/** The gateway's newest Claude model for an alias (`opus` → `claude/claude-opus-5-5`), or null. */
export function gatewayModelFor(alias: string, catalog: readonly string[]): string | null {
  const prefix = `claude/claude-${alias}-`
  let best: { id: string; v: number[] } | null = null
  for (const id of catalog) {
    const v = versionOf(id, prefix)
    if (v !== null && (best === null || newer(v, best.v))) best = { id, v }
  }
  return best?.id ?? null
}

/** Claude's own settings send it to a gateway (`env.ANTHROPIC_BASE_URL`), so an alias is that block's to resolve. */
export function claudeSettingsGateway(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false
  const env = (settings as { env?: unknown }).env
  if (typeof env !== 'object' || env === null) return false
  const url = (env as { ANTHROPIC_BASE_URL?: unknown }).ANTHROPIC_BASE_URL
  return typeof url === 'string' && url.trim().length > 0
}

const MODEL_FLAG = /(\s--model)(=|\s+)(\S+)/

/**
 * A direct claude card's launch line, with an alias `--model` spelled as the
 * gateway's id when the gateway lists one. Anything else is left as it was.
 */
export function withGatewayModel(command: string, catalog: readonly string[]): string {
  const match = MODEL_FLAG.exec(command)
  if (!match) return command
  const id = gatewayModelFor(match[3], catalog)
  return id === null ? command : command.replace(MODEL_FLAG, `$1$2${id}`)
}

const EFFORT_FLAG = /\s--effort(?:=|\s+)(\S+)/

/** The line with its effort carried onto a model that takes it, or dropped for one that does not. */
function withKeptEffort(command: string, effort: string | null | undefined, levels: readonly string[]): string {
  const own = EFFORT_FLAG.exec(command)?.[1]
  if (own !== undefined) return levels.includes(own) ? command : command.replace(EFFORT_FLAG, '')
  const kept = keptEffort(effort, levels)
  return kept === null ? command : launchCommand(command, { effort: kept })
}

/** The card after a model or effort pick, for where its turns go. */
export function launchPick(input: {
  command: string
  knob: LaunchKnob
  value: string
  /** The card's turns go through a route (RouteService.routeOf ≠ direct, gateway online). */
  routed: boolean
  catalog: readonly string[]
  /** A gateway model's effort levels (its catalog row); absent or empty: claude's own. */
  levelsOf?: (id: string) => readonly string[]
  /** The effort the card runs at now (its reading), carried onto a new model (owner 2026-11-04: keep it). */
  effort?: string | null
}): LaunchPlan {
  const { command, knob, value } = input
  const levels = (id: string | null): readonly string[] => {
    const own = id ? (input.levelsOf?.(id) ?? []).filter(isEffortLevel) : []
    return own.length > 0 ? own : EFFORT_LEVELS
  }
  if (knob === 'effort') return { command: launchCommand(command, { effort: value }) }
  const pick = parseModelPick(value)
  if (pick === null) return { error: `not a model this agent offers: ${value}` }
  // The one list's rows (model-pick.ts): a gateway id, or direct with an alias.
  if (pick.route === DIRECT) {
    return { command: withKeptEffort(launchCommand(withoutRoutedPick(command, 'claude'), { model: pick.alias }), input.effort, levels(null)), route: DIRECT }
  }
  if (pick.route !== undefined) {
    if (!input.catalog.includes(pick.route)) return { error: `not in the gateway's catalog: ${pick.route}` }
    return { command: withKeptEffort(withoutRoutedPick(command, 'claude'), input.effort, levels(pick.route)), route: pick.route }
  }
  // A bare alias (an older caller): where the card's turns already go.
  if (!input.routed) return { command: withKeptEffort(launchCommand(command, { model: pick.alias }), input.effort, levels(null)) }
  const route = gatewayModelFor(pick.alias, input.catalog)
  if (route === null) return { error: `the gateway lists no ${pick.alias} model to route to` }
  return { command: withKeptEffort(withoutRoutedPick(command, 'claude'), input.effort, levels(route)), route }
}

/**
 * A new claude agent's launch, from the prompt box's pick: a gateway id is
 * its route, `direct:<alias>` its flag and a direct route; the effort rides
 * as a flag. Anything else is the launch line as before (launchCommand).
 */
export function newAgentPlan(input: {
  command: string
  tune: unknown
  offer: LaunchOffer | null
  catalog: readonly string[]
  levelsOf?: (id: string) => readonly string[]
}): LaunchPatch {
  const raw = typeof input.tune === 'object' && input.tune !== null ? (input.tune as Record<string, unknown>) : {}
  const pick = typeof raw.model === 'string' ? parseModelPick(raw.model) : null
  const effort = typeof raw.effort === 'string' ? raw.effort : undefined
  if (pick?.route === DIRECT) return { command: launchCommand(input.command, { model: pick.alias, effort }, input.offer), route: DIRECT }
  if (pick?.route !== undefined && input.catalog.includes(pick.route)) {
    const own = (input.levelsOf?.(pick.route) ?? []).filter(isEffortLevel)
    const allowed = own.length > 0 ? own : EFFORT_LEVELS
    return { command: launchCommand(input.command, effort && allowed.includes(effort as never) ? { effort } : {}, input.offer), route: pick.route }
  }
  return { command: launchCommand(input.command, input.tune, input.offer) }
}
