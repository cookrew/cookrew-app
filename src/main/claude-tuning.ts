// Claude's half of the dials (shared/agent-tuning): the two slash commands it
// accepts as one line, and where it writes the answers back.
//
// Claude stamps every assistant record in its session file with the model that
// produced it (`message.model`, the full id) and the effort it ran at
// (`effort`, top level). That is what makes the rail honest rather than
// optimistic: the readout is the harness's own statement about a reply that
// already happened, so an ask that never took cannot masquerade as a setting.

import type { AgentTuning, HarnessTuning } from '../shared/agent-tuning'
import { isEffortLevel, tuneValueOk } from '../shared/agent-tuning'

/** The record shape this reads, kept narrow — everything else is ignored. */
interface ClaudeRecord {
  type?: unknown
  effort?: unknown
  timestamp?: unknown
  message?: { model?: unknown } | unknown
}

function modelOf(record: ClaudeRecord): string | null {
  const message = record.message
  if (typeof message !== 'object' || message === null) return null
  const model = (message as { model?: unknown }).model
  return typeof model === 'string' && model.length > 0 ? model : null
}

export const claudeTuning: HarnessTuning = {
  /** Both dials are settable here: each is one slash command with one word. */
  knobs: ['model', 'effort'],

  /**
   * Both knobs are spelled as their own slash command, so the knob name IS the
   * command. The value is re-checked here even though callers check it too:
   * this string is typed into a live PTY, and a validator that only runs at
   * one of two call sites is a validator that will eventually be skipped.
   */
  line: (knob, value) => (tuneValueOk(knob, value) ? `/${knob} ${value}` : null),

  /**
   * BOTH SLASH COMMANDS ALSO WRITE ~/.claude/settings.json.
   *
   * Claude answers "Set model to X and saved as your default for new
   * sessions", and that default is global to the machine — every agent that
   * boots afterwards starts there, whoever turned the dial. That used to take
   * a deliberately typed command; a rail makes it one click, so the rail says
   * it at the moment of picking rather than leaving it to be discovered when
   * the next teammate boots on a model nobody chose for them.
   */
  caveat: 'this also becomes the default every new agent boots on',

  read: (record) => {
    if (typeof record !== 'object' || record === null) return null
    const entry = record as ClaudeRecord
    // ASSISTANT RECORDS ONLY. A user record carries no model, and taking
    // `effort` off one would report a dial position with nothing behind it —
    // the readout has to name a reply that actually ran at those settings.
    if (entry.type !== 'assistant') return null
    const model = modelOf(entry)
    if (model === null) return null
    const effort = typeof entry.effort === 'string' && isEffortLevel(entry.effort)
      ? entry.effort
      : null
    const stamped = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    const tuning: AgentTuning = {
      model,
      effort,
      at: Number.isFinite(stamped) ? stamped : null,
    }
    return tuning
  },
}
