/**
 * A NEW AGENT'S MODEL AND EFFORT, PICKED BEFORE IT EXISTS (owner 2026-11-01:
 * the tune switch sits in the prompt box; with nobody targeted it picks what
 * the new agent starts on).
 *
 * A new agent is not typed into: its pane is still booting, and claude's
 * slash commands also save the pick as the machine's default for every later
 * session. So a new agent takes its pick as LAUNCH FLAGS instead, which apply
 * to that session only. A live claude agent is tuned the same way since
 * 2026-11-01: launchCommand rewrites its card's command and it restarts in
 * place on its own session (main/agent-relaunch).
 *
 * EVERY HARNESS THAT TAKES THE FLAGS gets the pick (owner 2026-11-01), each
 * spelled its own way:
 *
 *   claude    --model opus --effort high       aliases, never a pinned id
 *   codex     -m gpt-6.1-sol -c model_reasoning_effort=high
 *   pi        --model provider/id --thinking high
 *   opencode  --model provider/model           (no effort flag exists)
 *
 * Claude's values are constants, so its offer is known here. Every other
 * harness lists its models in catalogs on disk, which only main can read
 * (main/launch-offers.ts); its offer reaches the prompt box with the preset
 * list. An offer names its harness, and the harness decides the spelling.
 *
 * Effort can depend on the model: a codex model lists its own reasoning
 * levels, a pi model without reasoning takes only `off`. So an offer carries
 * the levels of the harness's DEFAULT model, plus a per-model override where
 * a model differs, and a pick is checked against the model it rides with.
 *
 * The values are checked twice — against the offer, and against a plain-word
 * shape — because they come off disk and become part of a shell command.
 *
 * Pure: the prompt box reads the offer, main appends the flags, tests run both.
 */

import { EFFORT_LEVELS, MODEL_ALIASES } from './agent-tuning'

export type LaunchKnob = 'model' | 'effort'

export const LAUNCH_KNOBS: readonly LaunchKnob[] = ['model', 'effort']

/** What a new agent was asked to start on. An absent knob = the harness's own default. */
export type LaunchTune = Partial<Record<LaunchKnob, string>>

/** The harnesses that take a launch pick (harness.ts ids). */
export type LaunchHarness = 'claude' | 'codex' | 'pi' | 'opencode'

/** The values a new agent of one harness can start on. */
export interface LaunchOffer {
  readonly harness: LaunchHarness
  readonly model: readonly string[]
  /** The effort levels with no model picked (the harness's default model). Empty: no effort dial. */
  readonly effort: readonly string[]
  /** A model's own levels, where they differ from `effort`. */
  readonly effortFor?: Readonly<Record<string, readonly string[]>>
}

const CLAUDE_OFFER: LaunchOffer = { harness: 'claude', model: MODEL_ALIASES, effort: EFFORT_LEVELS }

const isClaude = (command: string): boolean => /^\s*claude(\s|$)/.test(command)

/** The pick a new claude agent can take, or null: every other harness's offer comes from main. */
export function launchOffer(command: string): LaunchOffer | null {
  return isClaude(command) ? CLAUDE_OFFER : null
}

/** The effort levels a pick of this model can take. */
export function effortOffer(offer: LaunchOffer, model: string | undefined): readonly string[] {
  // Own keys only: a slug named `constructor` must not read Object.prototype.
  const own = model !== undefined && offer.effortFor !== undefined && Object.hasOwn(offer.effortFor, model)
  return (own ? offer.effortFor?.[model] : undefined) ?? offer.effort
}

/**
 * A value that stays one shell word: catalog ids look like `gpt-6.1-sol`,
 * `ifunk/k3`, `qwen3.8-27b-q8`, `claude-opus-5-5`. Anything else is refused
 * even when a catalog lists it, because a catalog is a file anyone can edit.
 */
const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/

/**
 * The pick, as far as this offer takes it: unknown knobs, unoffered values,
 * odd shapes and non-strings dropped. Input arrives over IPC and HTTP, so it
 * is unknown.
 */
export function cleanLaunchTune(offer: LaunchOffer | null, raw: unknown): LaunchTune {
  if (offer === null || typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  const ok = (value: unknown, allowed: readonly string[]): value is string =>
    typeof value === 'string' && PLAIN_WORD.test(value) && allowed.includes(value)
  const model = ok(record.model, offer.model) ? record.model : undefined
  const effort = ok(record.effort, effortOffer(offer, model)) ? record.effort : undefined
  return { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }
}

/** How one harness spells one knob: the flag to append, and the forms of it to take out first. */
interface FlagSpelling {
  flag: (value: string) => string
  strip: RegExp
}

const flagForm = (names: string): RegExp => new RegExp(`\\s(?:${names})(?:=|\\s+)\\S+`, 'g')

const SPELLING: Readonly<Record<LaunchHarness, Partial<Record<LaunchKnob, FlagSpelling>>>> = {
  claude: {
    model: { flag: (v) => `--model ${v}`, strip: flagForm('--model') },
    effort: { flag: (v) => `--effort ${v}`, strip: flagForm('--effort') }
  },
  codex: {
    model: { flag: (v) => `-m ${v}`, strip: flagForm('-m|--model') },
    // Codex has no effort flag: the level is a config override, which applies
    // to this session only and leaves ~/.codex/config.toml as it was.
    effort: {
      flag: (v) => `-c model_reasoning_effort=${v}`,
      strip: /\s(?:-c|--config)(?:=|\s+)model_reasoning_effort=\S+/g
    }
  },
  pi: {
    model: { flag: (v) => `--model ${v}`, strip: flagForm('--model') },
    effort: { flag: (v) => `--thinking ${v}`, strip: flagForm('--thinking') }
  },
  opencode: {
    model: { flag: (v) => `--model ${v}`, strip: flagForm('-m|--model') }
  }
}

/**
 * The launch command with the pick appended. Unchanged when nothing (valid)
 * was picked. `offer` defaults to what this module knows on its own, so a
 * caller without main's catalogs still launches claude with its pick.
 */
export function launchCommand(command: string, raw: unknown, offer: LaunchOffer | null = launchOffer(command)): string {
  if (offer === null) return command
  const tune = cleanLaunchTune(offer, raw)
  const spelling = SPELLING[offer.harness]
  return LAUNCH_KNOBS.reduce((line, knob) => {
    const value = tune[knob]
    const spell = spelling[knob]
    return value === undefined || spell === undefined ? line : `${line.replace(spell.strip, '')} ${spell.flag(value)}`
  }, command)
}

/**
 * A ROUTED card's command, without the pick a route decides instead (review
 * 2026-11-02). The route's args come after the command, and codex's `-m`
 * outranks the route's `-c model=`, so a codex catalog slug would be sent to
 * the Magpie provider; opencode would get `--model` twice; pi a thinking level
 * picked for another model. Claude keeps its flags: `--model opus` resolves
 * through the env the route sets.
 */
export function withoutRoutedPick(command: string, harness: string | null | undefined): string {
  const knobs: readonly LaunchKnob[] =
    harness === 'codex' || harness === 'opencode' ? ['model'] : harness === 'pi' ? ['model', 'effort'] : []
  const spelling = harness ? SPELLING[harness as LaunchHarness] : undefined
  return knobs.reduce((line, knob) => {
    const strip = spelling?.[knob]?.strip
    return strip ? line.replace(strip, '') : line
  }, command)
}

/** The chip's words: `opus · high`, `opus`, or null when nothing is picked. */
export function launchTuneLabel(tune: LaunchTune): string | null {
  const parts = LAUNCH_KNOBS.flatMap((knob) => (tune[knob] ? [tune[knob]] : []))
  return parts.length > 0 ? parts.join(' · ') : null
}
