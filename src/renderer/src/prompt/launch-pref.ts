import { LAUNCH_KNOBS, cleanLaunchTune, type LaunchKnob, type LaunchOffer, type LaunchTune } from '../../../shared/launch-tune'
import { DIRECT, effortLevelsFor, keptEffort, parseModelPick } from '../../../shared/model-pick'

/**
 * THE MODEL AND EFFORT A NEW AGENT STARTS ON (owner, 2026-11-01): the prompt
 * box's tune chip, with nobody targeted. Sticky like the harness chip
 * (harness-pref.ts), and PER HARNESS: a codex model means nothing to claude,
 * so each harness keeps its own last pick. An absent knob means the harness's
 * own default, and is never sent.
 *
 * Stored as { [preset name]: pick }. The first version stored one flat pick
 * when only claude had the chip; that is read as Claude Code's.
 */

const KEY = 'cookrew.new-agent-tune'
/** The preset the flat first-version pick belonged to (main/presets.ts). */
const FIRST_HARNESS = 'Claude Code'

function asTune(raw: unknown): LaunchTune {
  if (typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  return LAUNCH_KNOBS.reduce<LaunchTune>((out, knob) => {
    const value = record[knob]
    return typeof value === 'string' && value ? { ...out, [knob]: value } : out
  }, {})
}

function readAll(): Record<string, LaunchTune> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const record = raw as Record<string, unknown>
    if (LAUNCH_KNOBS.some((knob) => knob in record)) return { [FIRST_HARNESS]: asTune(record) }
    return Object.fromEntries(Object.entries(record).map(([name, tune]) => [name, asTune(tune)]))
  } catch {
    // private mode or a torn value: no pick, the harness's defaults stand
    return {}
  }
}

export function lastLaunchTune(harness: string): LaunchTune {
  return readAll()[harness] ?? {}
}

export function rememberLaunchTune(harness: string, tune: LaunchTune): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [harness]: tune }))
  } catch {
    // private mode: not remembered
  }
}

/** The pick with one knob set, or cleared back to the default (null). */
export function withLaunchKnob(tune: LaunchTune, knob: LaunchKnob, value: string | null): LaunchTune {
  const { [knob]: _dropped, ...rest } = tune
  return value === null ? rest : { ...rest, [knob]: value }
}

/**
 * What this harness would actually take of the pick — an effort checked
 * against the model it rides with. The rest stays remembered, unsent.
 */
export function offeredPart(tune: LaunchTune, offer: LaunchOffer | null): LaunchTune {
  return cleanLaunchTune(offer, tune)
}

/**
 * THE ONE LIST'S PICK for a new claude agent (owner 2026-11-04): a gateway id
 * or `direct:<alias>` (shared/model-pick.ts) is kept while the gateway lists
 * it, with an effort its model takes; anything else is narrowed as before
 * (offeredPart). Main turns the pick into a route and flags.
 */
export function offeredPick(tune: LaunchTune, offer: LaunchOffer | null, gateway: { ids: readonly string[]; models: readonly { id: string; levels: readonly string[] }[] } | null): LaunchTune {
  const pick = tune.model !== undefined ? parseModelPick(tune.model) : null
  if (offer?.harness !== 'claude' || gateway === null || pick === null || pick.route === undefined) return offeredPart(tune, offer)
  if (pick.route !== DIRECT && !gateway.ids.includes(pick.route)) return offeredPart({ ...(tune.effort ? { effort: tune.effort } : {}) }, offer)
  const effort = keptEffort(tune.effort, effortLevelsFor(tune.model, gateway.models))
  return { model: tune.model as string, ...(effort !== null ? { effort } : {}) }
}
