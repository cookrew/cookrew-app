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
  // Nothing here is settable from one typed line; see the header.
  knobs: [],
  line: () => null,

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
