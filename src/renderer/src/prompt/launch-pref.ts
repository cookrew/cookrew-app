import { LAUNCH_KNOBS, type LaunchKnob, type LaunchOffer, type LaunchTune } from '../../../shared/launch-tune'

/**
 * THE MODEL AND EFFORT A NEW AGENT STARTS ON (owner, 2026-11-01): the prompt
 * box's tune chip, with nobody targeted. Sticky like the harness chip
 * (harness-pref.ts): the next agent takes the last pick until another is made.
 * An absent knob means the harness's own default, and is never sent.
 */

const KEY = 'cookrew.new-agent-tune'

export function lastLaunchTune(): LaunchTune {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (typeof raw !== 'object' || raw === null) return {}
    const record = raw as Record<string, unknown>
    return LAUNCH_KNOBS.reduce<LaunchTune>((out, knob) => {
      const value = record[knob]
      return typeof value === 'string' && value ? { ...out, [knob]: value } : out
    }, {})
  } catch {
    // private mode or a torn value: no pick, the harness's defaults stand
    return {}
  }
}

export function rememberLaunchTune(tune: LaunchTune): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(tune))
  } catch {
    // private mode: not remembered
  }
}

/** The pick with one knob set, or cleared back to the default (null). */
export function withLaunchKnob(tune: LaunchTune, knob: LaunchKnob, value: string | null): LaunchTune {
  const { [knob]: _dropped, ...rest } = tune
  return value === null ? rest : { ...rest, [knob]: value }
}

/** What this harness would actually take of the pick: the rest waits for a harness that does. */
export function offeredPart(tune: LaunchTune, offer: LaunchOffer | null): LaunchTune {
  if (offer === null) return {}
  return LAUNCH_KNOBS.reduce<LaunchTune>((out, knob) => {
    const value = tune[knob]
    return value !== undefined && offer[knob].includes(value) ? { ...out, [knob]: value } : out
  }, {})
}
