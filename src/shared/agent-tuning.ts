/**
 * THE TWO DIALS AN AGENT HAS: which model answers, and how hard it thinks.
 *
 * Both are things you change mid-conversation today by typing `/model` or
 * `/effort` into the pane and reading the TUI's reply — which means the only
 * place either value is legible is the pane you are already looking at, and
 * the only way to change one on a card you zoomed into is to remember the
 * spelling. This module is the pure half of putting both on the card.
 *
 * Three decisions are encoded here, and each one is a refusal:
 *
 *  1. ALIASES ONLY, NEVER A PINNED MODEL ID. On 2026-08-06 a fleet-wide model
 *     sweep wrote a pinned id (`claude-opus-4-8[1m]`) into agents whose CLI
 *     binary predated it. The backend rejected the id and every one of those
 *     agents went dead while still reporting healthy — they answered in about
 *     a second with "There's an issue with the selected model" and dropped the
 *     work. An alias is resolved by the binary the agent actually booted with,
 *     so a picker built from aliases cannot name a model that binary lacks.
 *     A long-running agent keeps the binary it booted with forever, so this is
 *     not a transitional hazard; it is the permanent shape of the fleet.
 *
 *  2. EVERY OFFERED VALUE IS ONE THE RECORD CAN CONFIRM. The harness writes
 *     the model and the effort it actually used onto each reply in its session
 *     file, so a dial can be read back from durable state rather than scraped
 *     off a screen. `auto` and `ultracode` are deliberately NOT offered: both
 *     resolve to some other level before they are recorded, so a rail showing
 *     them could never say whether the ask took.
 *
 *  3. ASKED IS NOT SET. A slash command is typed into a TUI; nothing about
 *     that is a transaction. Until a reply lands carrying the new value, the
 *     rail says ASKED and says what it is waiting for. When a reply lands
 *     still carrying the OLD value, the ask was refused — which is exactly the
 *     symptom of decision 1's incident — and the rail says that instead of
 *     quietly showing a number the agent is not running on.
 *
 * Pure: no fs, no Electron, no React. The main process reads the record, the
 * renderer draws these rows, and tests run the decisions without either.
 */

import type { TurnPhase } from './turn'

/** The dials. One name, used as the slash command and as the wire key. */
export type TuneKnob = 'model' | 'effort'

export const TUNE_KNOBS: readonly TuneKnob[] = ['model', 'effort']

/**
 * A knob name arrives over IPC from the renderer and ends up inside a line
 * typed into a live PTY, so it is checked rather than trusted: an unchecked
 * name would fall through to the effort branch of tuneValues and compose
 * `/<whatever> low`.
 */
export function isTuneKnob(value: string): value is TuneKnob {
  return (TUNE_KNOBS as readonly string[]).includes(value)
}

/**
 * Effort levels offered, cheapest first.
 *
 * These are the five the harness both accepts as an argument AND writes back
 * onto a reply, which is what makes each of them confirmable (decision 2).
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Model aliases offered, strongest first.
 *
 * An alias means "the latest model of this family, as this binary knows it" —
 * see decision 1. The set is deliberately small and deliberately unversioned:
 * adding `opus-4-8` here would re-create the pinned-id hazard with extra steps.
 */
export type ModelAlias = 'fable' | 'opus' | 'sonnet' | 'haiku'

export const MODEL_ALIASES: readonly ModelAlias[] = ['fable', 'opus', 'sonnet', 'haiku']

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function isModelAlias(value: string): value is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(value)
}

/** The values a knob will accept. Anything else never reaches a PTY. */
export function tuneValues(knob: TuneKnob): readonly string[] {
  return knob === 'model' ? MODEL_ALIASES : EFFORT_LEVELS
}

export function tuneValueOk(knob: TuneKnob, value: string): boolean {
  return tuneValues(knob).includes(value)
}

/**
 * What the harness itself recorded on its last reply.
 *
 * `model` is VERBATIM — the full id the harness wrote (`claude-opus-5`), not
 * the alias that was asked for. The two are different statements: the alias is
 * what we requested, the id is what answered, and showing the request back as
 * if it were the answer is how a rail would hide a model that silently did not
 * change.
 */
export interface AgentTuning {
  model: string | null
  /**
   * VERBATIM too, and deliberately a plain string rather than EffortLevel: a
   * harness we only READ (codex) writes levels from its own vocabulary, and
   * typing this to the set we OFFER would either drop those readings or force
   * the offer open. The offer is closed; the readout is whatever was written.
   */
  effort: string | null
  /** Epoch ms of the record these were read from; null when nothing recorded. */
  at: number | null
}

/** One dial turn, remembered until a reply settles it. */
export interface TuneAsk {
  knob: TuneKnob
  value: string
  /** Epoch ms the line was typed into the pane. */
  at: number
}

/** What main hands the renderer for one card. */
export interface AgentTuningState {
  /** Harness id, or null when this card runs no agent we know. */
  harness: string | null
  /**
   * The dials this harness can be TURNED by from here — empty for a harness
   * we can only read. Read and write are separate capabilities: codex writes
   * its model and effort onto every turn (so every card can wear them) and
   * changes them only in its own interactive picker (so no button here can).
   */
  knobs: TuneKnob[]
  tuning: AgentTuning | null
  asks: TuneAsk[]
  /** The harness's own caveat about picking (HarnessTuning.caveat). */
  caveat: string | null
  /**
   * Per-knob values, when this harness does not use the shared defaults.
   * Computed in main because the source is on disk (pi reads its own model
   * catalogs), and the renderer has no disk.
   */
  choices?: Partial<Record<TuneKnob, readonly string[]>>
  /** Knobs whose asks can be CONFIRMED from the record (HarnessTuning.records). */
  records: TuneKnob[]
}

/**
 * What a harness must say about its dials to get a rail (harness-integration
 * contract: a capability is DECLARED in the registry, never inferred at a call
 * site). Absent means "no dials" — a harness gets the rail's explanation, not
 * a guess at its slash commands.
 *
 * `read` is the half that matters: a harness cannot declare dials it does not
 * write back onto its own replies, because then nothing could ever confirm an
 * ask and the rail would be a set of buttons with no readout.
 */
export interface HarnessTuning {
  /**
   * The dials this harness can be SET by from one typed line. May be empty:
   * `read` alone is a complete and useful declaration — it is what puts the
   * model and effort on every card.
   */
  knobs: readonly TuneKnob[]
  /** The line to type for a knob, or null when this harness lacks that dial. */
  line: (knob: TuneKnob, value: string) => string | null
  /** The dials carried by ONE parsed session-file record; null when it has none. */
  read: (record: unknown) => AgentTuning | null
  /**
   * The values THIS harness will accept, when they are not a constant.
   *
   * Claude's are fixed aliases. Pi's are whatever its own catalogs on disk
   * list, and its thinking levels depend on the model currently loaded — so a
   * hard-coded list would be wrong on both counts, and being wrong is not
   * cosmetic there: pi answers an unknown MODEL by opening a picker that
   * swallows every subsequent keystroke. Offering only values the harness
   * itself lists is what keeps a click from stranding a pane in a modal.
   *
   * Returning null means "use the shared default".
   */
  values?: (knob: TuneKnob, current: AgentTuning | null) => readonly string[] | null
  /**
   * The knobs this harness WRITES BACK onto its own records, and therefore
   * the ones an ask can be confirmed against. Defaults to `knobs`.
   *
   * Pi is the reason this exists: it stamps the model on every reply and
   * never records the thinking level at all. A level can still be set — the
   * command is safe and fails safely — but nothing on disk will ever agree
   * that it took, so the rail must say that rather than wait forever.
   */
  records?: readonly TuneKnob[]
  /**
   * How far back a COLD read should look, in escalating byte windows. Default
   * suits a harness that stamps every reply; a harness that stamps once per
   * TURN must declare larger ones, because the distance from the end of the
   * file is then the whole turn's output rather than one record.
   */
  tailSteps?: readonly number[]
  /**
   * One sentence about what turning a dial ALSO does, shown at the moment of
   * picking. Declared by the harness because it is the harness's own
   * behaviour, and stated because this rail turns something that used to take
   * a deliberately typed slash command into one click.
   */
  caveat?: string
}

export const TUNE_COPY = {
  model: { label: 'MDL', title: 'Model' },
  effort: { label: 'EFF', title: 'Effort' },
  /** No reply has been recorded yet, so nothing is known about the dials. */
  unread: 'no reply recorded yet',
  /** The ask is typed; the harness confirms it on its next reply. */
  pending: 'asked · confirms on the next reply',
  /**
   * A reply landed AFTER the ask and still reads the old value. This is the
   * pinned-id incident's fingerprint, so it names the remedy rather than
   * leaving a number on screen that the agent is not running on.
   */
  refused: 'asked, but the last reply still says otherwise — check the pane',
  /** Typing into a pane mid-turn contaminates the input box. */
  busy: 'mid-turn — the dials wait for the reply',
  /** A line into a session at someone else's app: their dials, not ours. */
  remote: 'this session runs elsewhere',
  /**
   * Sent, and unverifiable HERE — this harness does not write the value onto
   * its records. Says where the truth is instead of pretending to hold it.
   */
  unrecorded: 'sent · this agent does not record it, so the pane is the readout',
  /**
   * The harness is known but cannot be turned by typing one line.
   *
   * Codex is the case this exists for, and the reason is worth the words:
   * `/model <anything>` is not a command there — codex sends it to the model
   * as a PROMPT (verified in a PTY: it started a turn and made an API call).
   * So a button here would not fail, it would inject junk into the
   * conversation and spend a turn. Its picker is the only safe way in.
   */
  noDials: (harness: string): string =>
    `${harness} changes this in its own picker — type /model in the pane`,
} as const

/**
 * The PTY input gate's verdict, said as a sentence. The gate's vocabulary is
 * about producers and leases; the rail's reader is looking at a card.
 */
export function inputRefusal(verdict: string): string {
  return verdict === 'preempt-failed'
    ? 'the pane is mid-delivery and would not yield'
    : 'the input box is not free'
}

/**
 * The alias a recorded model id belongs to, or null for a model outside the
 * offered set (a third-party or Bedrock id, or a family we do not list).
 *
 * Segment match, not substring: `opusplan` is its own mode and must not read
 * as `opus`, and a substring test would say it does.
 */
export function modelAliasOf(model: string): ModelAlias | null {
  const segments = model.toLowerCase().split(/[^a-z0-9]+/)
  return MODEL_ALIASES.find((alias) => segments.includes(alias)) ?? null
}

/**
 * What a dial's rows are compared against: the alias for a model, the level
 * itself for effort. Null when the recording is absent or unmappable — and
 * unmappable is not "none of the rows", it is "a model we do not offer", which
 * the view states separately.
 */
export function dialReading(
  knob: TuneKnob,
  tuning: AgentTuning | null,
  choices?: readonly string[]
): string | null {
  if (tuning === null) return null
  if (knob === 'effort') return tuning.effort
  if (tuning.model === null) return null
  // AGAINST THE OFFERED VALUES FIRST, and only then against claude's aliases.
  //
  // Aliases are a claude idea. A pi card offers `qwen-local/qwen3.8-27b-q8`
  // and its records say `qwen3.8-27b-q8`, so an alias-only reading returned
  // null and NO row ticked on any pi card — the dial listed four models and
  // claimed none of them was the one running. The suffix match is what joins
  // a bare recorded id to the provider-qualified ref the harness accepts.
  if (choices !== undefined) {
    const exact = choices.find((choice) => choice === tuning.model)
    if (exact !== undefined) return exact
    const qualified = choices.find((choice) => choice.endsWith(`/${tuning.model}`))
    if (qualified !== undefined) return qualified
  }
  return modelAliasOf(tuning.model)
}

/** The exact line typed into the pane. Callers must check tuneValueOk first. */
export function tuneLine(knob: TuneKnob, value: string): string {
  return `/${knob} ${value}`
}

/**
 * How an outstanding ask stands against the record.
 *
 * 'settled'  — the record already reads what was asked for; the ask is done.
 * 'pending'  — no reply has been recorded since the ask, so nothing is known.
 * 'refused'  — a reply landed after the ask and still reads the old value.
 */
/**
 * 'unrecorded' is the third thing that can be true of an ask, and it is a
 * property of the HARNESS rather than of time: pi accepts a thinking level and
 * never writes one down, so 'pending' would be a promise that never resolves
 * and 'refused' would be an accusation nothing supports. The honest report is
 * that it was sent and that nothing here can check it.
 */
export type AskOutcome = 'settled' | 'pending' | 'refused' | 'unrecorded'

export function askOutcome(
  ask: TuneAsk,
  tuning: AgentTuning | null,
  records: readonly TuneKnob[] = TUNE_KNOBS,
  choices?: readonly string[]
): AskOutcome {
  if (!records.includes(ask.knob)) return 'unrecorded'
  const reading = dialReading(ask.knob, tuning, choices)
  if (reading === ask.value) return 'settled'
  // No record at all, or a record older than the ask: the harness has not had
  // a chance to answer, so "did it take?" has no answer yet either.
  if (tuning === null || tuning.at === null || tuning.at <= ask.at) return 'pending'
  return 'refused'
}

/** The newest unsettled ask for a knob, or null when the dial is at rest. */
export function liveAsk(
  knob: TuneKnob,
  asks: readonly TuneAsk[],
  tuning: AgentTuning | null,
  records: readonly TuneKnob[] = TUNE_KNOBS,
  choices?: readonly string[]
): { ask: TuneAsk; outcome: Exclude<AskOutcome, 'settled'> } | null {
  for (let i = asks.length - 1; i >= 0; i -= 1) {
    const ask = asks[i]
    if (ask.knob !== knob) continue
    const outcome = askOutcome(ask, tuning, records, choices)
    return outcome === 'settled' ? null : { ask, outcome }
  }
  return null
}

export type TuneRowState = 'current' | 'asked' | 'plain'

export interface TuneRow {
  value: string
  state: TuneRowState
}

export interface TuneDial {
  knob: TuneKnob
  /** Short rail label — MDL / EFF. */
  label: string
  /** Full name for the accessible name and the tooltip. */
  title: string
  /**
   * What the record says, VERBATIM (`claude-opus-5`, `max`) — null when
   * nothing has been recorded. This is the value the chip shows, so the chip
   * can never show an alias the agent never confirmed.
   */
  reading: string | null
  /** The row the reading maps to; null when the model is outside the offered set. */
  current: string | null
  rows: TuneRow[]
  /** The unsettled ask, if any — what the dial was turned to and how it stands. */
  asked: string | null
  outcome: Exclude<AskOutcome, 'settled'> | null
  /** One sentence under the chip; null when the dial has nothing to add. */
  note: string | null
}

/**
 * What the chip shows in a rail 46 pixels wide.
 *
 * A model reads as its alias when the id maps to one — `opus` is the thing you
 * asked for and the thing you would ask for again. An id OUTSIDE the offered
 * set (a Bedrock arn, a family we do not list) is shown verbatim and left to
 * clip: the full string stays in the chip's title and accessible name, and a
 * rail that abbreviated an unknown model would be inventing a name for it.
 */
export function chipText(dial: TuneDial): string {
  if (dial.reading === null) return '\u2014'
  return dial.knob === 'model' ? (dial.current ?? dial.reading) : dial.reading
}

export interface TuneRailView {
  /** What picking ALSO does on this harness; null when it does nothing else. */
  caveat: string | null
  dials: TuneDial[]
  /**
   * Why no dial may be turned right now, or null when they may be. Rows still
   * render while locked — the current value is worth reading even when it
   * cannot be changed, and a rail that vanishes mid-turn is a rail that
   * flickers on every reply.
   */
  locked: string | null
}

/**
 * WHAT AN AGENT IS RUNNING ON, IN AS FEW WORDS AS A CARD HAS ROOM FOR.
 *
 * Rendered beside the harness chip on every view of a card — `codex
 * gpt-6-astra high`, `Claude Code opus max` — so the two facts that decide
 * what a teammate costs and how well it thinks stop being invisible until
 * someone zooms in and reads a TUI.
 *
 * The model reads as its ALIAS when it has one, exactly as the rail's chip
 * does. That is one rule across every surface rather than a card that says
 * `claude-opus-5` and a rail two pixels away that says `opus`; the full id
 * stays in the title on both. Null means nothing has been recorded — and the
 * caller draws no tag, because a blank chip is a claim too.
 */
export interface TuningWords {
  /** The model as the tag shows it — its alias when it has one. */
  model: string | null
  effort: string | null
}

/**
 * The tag's two parts, separately.
 *
 * A mini tile is about five characters wide at overview zoom — measured, the
 * one-line tag needed 402px in a 253px box and EVERY tile clipped it, which
 * cost the effort entirely. So the narrow surfaces stack the two parts on
 * their own lines rather than leaving it to where a wrap happens to land: a
 * long model id then clips alone, and the effort is always on screen.
 */
export function tuningWords(tuning: AgentTuning | null): TuningWords {
  if (tuning === null) return { model: null, effort: null }
  return {
    // The tag stays alias-or-verbatim: a provider-qualified ref is the thing
    // you PICK, not the thing a 46px tile can say.
    model: tuning.model === null ? null : (modelAliasOf(tuning.model) ?? tuning.model),
    effort: tuning.effort === null || tuning.effort.length === 0 ? null : tuning.effort
  }
}

export function tuningTag(tuning: AgentTuning | null): string | null {
  const { model, effort } = tuningWords(tuning)
  const words = [model, effort].filter((w): w is string => w !== null && w.length > 0)
  return words.length > 0 ? words.join(' ') : null
}

/** The unabbreviated version, for the tag's title. */
export function tuningTitle(tuning: AgentTuning | null): string | null {
  if (tuning === null) return null
  const words = [tuning.model, tuning.effort === null ? null : `effort ${tuning.effort}`].filter(
    (w): w is string => w !== null && w.length > 0
  )
  return words.length > 0 ? words.join(' \u00b7 ') : null
}

export interface TuneRailInput {
  state: AgentTuningState | null
  phase: TurnPhase
  /** The card is a line into a session at someone else's app. */
  remote: boolean
}

/**
 * The whole rail, decided here so the component only draws.
 *
 * Returns null for a card with no harness at all — a plain shell has no model
 * and no effort, and a dial that says "not applicable" on every shell card is
 * furniture. A harness WITHOUT dials still gets a rail: it has both values,
 * we just cannot set them from here, and saying where they are set beats
 * leaving the question unanswered.
 */
export function tuneRailView(input: TuneRailInput): TuneRailView | null {
  const state = input.state
  if (state === null || state.harness === null) return null

  const settable = state.knobs.length > 0
  const locked = input.remote
    ? TUNE_COPY.remote
    : !settable
      ? TUNE_COPY.noDials(state.harness)
      : input.phase === 'thinking'
        ? TUNE_COPY.busy
        : null

  const dials = state.knobs.map((knob) => dialView(knob, state))
  // The caveat belongs to the act of picking, so it travels with the rail even
  // while the rail is locked — someone reading a locked dial is deciding
  // whether to come back and turn it.
  return { dials, locked, caveat: settable ? state.caveat : null }
}

function dialView(knob: TuneKnob, state: AgentTuningState): TuneDial {
  const copy = TUNE_COPY[knob]
  const tuning = state.tuning
  const reading = knob === 'model' ? (tuning?.model ?? null) : (tuning?.effort ?? null)
  // The harness's OWN values when it has them: pi's models come from its
  // catalogs on disk, and offering anything else opens a picker that eats
  // keystrokes (see HarnessTuning.values).
  const values = state.choices?.[knob] ?? tuneValues(knob)
  const current = dialReading(knob, tuning, values)
  const live = liveAsk(knob, state.asks, tuning, state.records, values)
  const rows = values.map<TuneRow>((value) => ({
    value,
    state: value === live?.ask.value ? 'asked' : value === current ? 'current' : 'plain',
  }))
  // A knob nobody writes down has no reading to show and no row to tick — the
  // rail says where the truth is instead of leaving a blank that reads as zero.
  const unrecorded = !state.records.includes(knob)
  return {
    knob,
    label: copy.label,
    title: copy.title,
    reading,
    current,
    rows,
    asked: live?.ask.value ?? null,
    outcome: live?.outcome ?? null,
    note:
      live !== null
        ? live.outcome === 'pending'
          ? TUNE_COPY.pending
          : live.outcome === 'unrecorded'
            ? TUNE_COPY.unrecorded
            : TUNE_COPY.refused
        : unrecorded
          ? TUNE_COPY.unrecorded
          : reading === null
            ? TUNE_COPY.unread
            : null,
  }
}
