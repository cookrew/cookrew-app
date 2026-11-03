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

import { launchCommand, withoutRoutedPick, type LaunchKnob } from '../shared/launch-tune'

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

/** The card after a model or effort pick, for where its turns go. */
export function launchPick(input: {
  command: string
  knob: LaunchKnob
  value: string
  /** The card's turns go through a route (RouteService.routeOf ≠ direct, gateway online). */
  routed: boolean
  catalog: readonly string[]
}): LaunchPlan {
  const { command, knob, value } = input
  if (knob === 'effort' || !input.routed) return { command: launchCommand(command, { [knob]: value }) }
  const route = gatewayModelFor(value, input.catalog)
  if (route === null) return { error: `the gateway lists no ${value} model to route to` }
  return { command: withoutRoutedPick(command, 'claude'), route }
}
