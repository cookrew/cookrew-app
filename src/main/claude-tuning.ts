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

/** Flatten a record's message content to text, whatever shape it is in. */
function textOf(record: ClaudeRecord): string {
  const message = record.message
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .join(' ')
}

const MODEL_SET = /Set model to `([^`]+)`/
const EFFORT_SET = /Set effort level to ([a-z]+)/

/**
 * A `/model` or `/effort` that SUCCEEDED, read off the local command's own
 * recorded output. Reports only the dial it names — the other stays null and
 * the scanner keeps walking back for it.
 */
function fromCommandResult(record: ClaudeRecord): AgentTuning | null {
  const text = textOf(record)
  if (!text.includes('<local-command-stdout>')) return null
  const model = MODEL_SET.exec(text)?.[1] ?? null
  const effort = EFFORT_SET.exec(text)?.[1] ?? null
  if (model === null && effort === null) return null
  const stamped = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  return { model, effort, at: Number.isFinite(stamped) ? stamped : null }
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
    // THE HARNESS'S OWN ACKNOWLEDGMENT, and it is durable.
    //
    // Waiting for the next assistant record was too slow to be useful: the
    // pane plainly said "Set model to Fable 5.1" while the rail still read
    // `opus`, because an idle agent may not reply for minutes. But claude
    // writes the command AND its result into the session file the moment it
    // runs — `<local-command-stdout>Set model to \`Fable 5.1\`…`. That is a
    // record, not a screen, so reading it keeps the rule this module is built
    // on (durable state only) while making the readout immediate.
    //
    // It only ever matches a SUCCESS: a rejected pick prints an error instead,
    // which is what keeps a refused ask detectable rather than papered over.
    if (entry.type === 'user') return fromCommandResult(entry)
    // An assistant record is the stronger statement — what a reply ACTUALLY
    // ran at, rather than what was accepted for the next one.
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
