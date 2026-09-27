// Codex's half of the dials (shared/agent-tuning): READ ONLY, and complete.
//
// Codex opens `/model` as an interactive picker — a list you arrow through,
// not a line you type — so nothing here can set a dial from a button, and
// `knobs` is empty rather than pretending otherwise. What it CAN do is the
// half that puts the model and effort on every card: codex writes a
// `turn_context` record at the START of every turn carrying `model` and
// `effort`, which is a fresher readout than a harness that only stamps its
// replies.
//
// This is why read and write are separate capabilities on HarnessTuning. A
// single boolean would have forced a choice between showing codex cards a tag
// they can have, and offering them buttons that do nothing.

import type { AgentTuning, HarnessTuning } from '../shared/agent-tuning'

/** The rollout record this reads, kept narrow — everything else is ignored. */
interface CodexRecord {
  type?: unknown
  timestamp?: unknown
  payload?: { model?: unknown; effort?: unknown } | unknown
}

export const codexTuning: HarnessTuning = {
  // NOTHING HERE IS SETTABLE, and this is a refusal rather than a gap.
  //
  // Verified by driving a real codex in a PTY: `/model gpt-5.6-sol high` is
  // NOT parsed as a command — codex sent the whole string to the model as a
  // prompt and started a turn. So a model button on a codex card would not
  // fail safely, it would put junk in the conversation and spend a turn every
  // time it was pressed. Bare `/model` opens a picker, which is arrow keys and
  // a modal that eats input if a drive goes wrong.
  //
  // Both halves are still READ, so a codex card wears its tag like any other.
  knobs: [],
  line: () => null,

  /**
   * MUCH larger windows than the default, because `turn_context` is written
   * once per TURN rather than once per reply: the distance back from the end
   * of the file is the whole turn's output, not one record. Measured on this
   * fleet, three live codex agents had their last one 452 KB, 941 KB and
   * 3.0 MB back in rollouts of 10-64 MB — every one of them outside the
   * default 256 KB, so every one of them showed no tag at all.
   *
   * The cost is paid at most once per file: after a cold read the cache
   * follows the file forward by its appended bytes alone.
   */
  tailSteps: [128 * 1024, 2 * 1024 * 1024, 16 * 1024 * 1024],

  read: (record) => {
    if (typeof record !== 'object' || record === null) return null
    const entry = record as CodexRecord
    if (entry.type !== 'turn_context') return null
    const payload = entry.payload
    if (typeof payload !== 'object' || payload === null) return null
    const { model, effort } = payload as { model?: unknown; effort?: unknown }
    if (typeof model !== 'string' || model.length === 0) return null
    const stamped = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    const tuning: AgentTuning = {
      model,
      // Codex spells its levels from its own vocabulary, so this is taken
      // verbatim rather than checked against the levels we OFFER — the offer
      // is closed, the readout is whatever the harness wrote.
      effort: typeof effort === 'string' && effort.length > 0 ? effort : null,
      at: Number.isFinite(stamped) ? stamped : null,
    }
    return tuning
  },
}
