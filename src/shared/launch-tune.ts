/**
 * A NEW AGENT'S MODEL AND EFFORT, PICKED BEFORE IT EXISTS (owner 2026-11-01:
 * the tune switch sits in the prompt box; with nobody targeted it picks what
 * the new agent starts on).
 *
 * A live agent is tuned by typing `/model` or `/effort` into its pane
 * (agent-tuning.ts). A new one is not typed into: its pane is still booting,
 * and claude's slash commands also save the pick as the machine's default for
 * every later session. So a new agent takes its pick as LAUNCH FLAGS instead —
 * `claude --model opus --effort high` — which apply to that session only.
 *
 * Only a harness that takes both flags is offered the pick (claude). Every
 * other harness launches as it always did. The values are agent-tuning's own
 * offer (aliases only, never a pinned id: see decision 1 there), checked here
 * a second time because the result becomes part of a shell command.
 *
 * Pure: the prompt box reads the offer, main appends the flags, tests run both.
 */

import { EFFORT_LEVELS, MODEL_ALIASES } from './agent-tuning'

export type LaunchKnob = 'model' | 'effort'

export const LAUNCH_KNOBS: readonly LaunchKnob[] = ['model', 'effort']

/** What a new agent was asked to start on. An absent knob = the harness's own default. */
export type LaunchTune = Partial<Record<LaunchKnob, string>>

/** The values each knob offers a new agent of this command, or null when it offers none. */
export type LaunchOffer = Readonly<Record<LaunchKnob, readonly string[]>>

const CLAUDE_OFFER: LaunchOffer = { model: MODEL_ALIASES, effort: EFFORT_LEVELS }

const isClaude = (command: string): boolean => /^\s*claude(\s|$)/.test(command)

/** The pick a new agent of this launch command can take, or null for none. */
export function launchOffer(command: string): LaunchOffer | null {
  return isClaude(command) ? CLAUDE_OFFER : null
}

/**
 * The pick, as far as this command takes it: unknown knobs, unoffered values
 * and non-strings dropped. Input arrives over IPC and HTTP, so it is unknown.
 */
export function cleanLaunchTune(command: string, raw: unknown): LaunchTune {
  const offer = launchOffer(command)
  if (offer === null || typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  return LAUNCH_KNOBS.reduce<LaunchTune>((out, knob) => {
    const value = record[knob]
    return typeof value === 'string' && offer[knob].includes(value) ? { ...out, [knob]: value } : out
  }, {})
}

/** A flag already in the command: the pick replaces it rather than repeating it. */
const flagPattern = (knob: LaunchKnob): RegExp => new RegExp(`\\s--${knob}(?:=|\\s+)\\S+`, 'g')

/** The launch command with the pick appended. Unchanged when nothing (valid) was picked. */
export function launchCommand(command: string, raw: unknown): string {
  const tune = cleanLaunchTune(command, raw)
  return LAUNCH_KNOBS.reduce((line, knob) => {
    const value = tune[knob]
    return value === undefined ? line : `${line.replace(flagPattern(knob), '')} --${knob} ${value}`
  }, command)
}

/** The chip's words: `opus · high`, `opus`, or null when nothing is picked. */
export function launchTuneLabel(tune: LaunchTune): string | null {
  const parts = LAUNCH_KNOBS.flatMap((knob) => (tune[knob] ? [tune[knob]] : []))
  return parts.length > 0 ? parts.join(' · ') : null
}
