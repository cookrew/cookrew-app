// Pi's half of the dials (shared/agent-tuning): READ ONLY, and MODEL ONLY.
//
// Pi stamps each assistant message with the model that produced it
// (`message.model`, e.g. `k3`) — same place claude puts it — so a pi card can
// wear what it is running on. It records no effort at all, and this reports
// none rather than inventing one: `tuningWords` then yields a model and a null
// effort, and every surface already draws whichever half it has.
//
// Nothing here is settable. Pi has no one-line command for the model, so
// `knobs` is empty and the zoomed rail says where it IS set instead of
// offering buttons that would do nothing.

import type { AgentTuning, HarnessTuning } from '../shared/agent-tuning'

/** The record shape this reads, kept narrow — everything else is ignored. */
interface PiRecord {
  type?: unknown
  timestamp?: unknown
  message?: { role?: unknown; model?: unknown; timestamp?: unknown } | unknown
}

export const piTuning: HarnessTuning = {
  knobs: [],
  line: () => null,

  read: (record) => {
    if (typeof record !== 'object' || record === null) return null
    const entry = record as PiRecord
    if (entry.type !== 'message') return null
    const message = entry.message
    if (typeof message !== 'object' || message === null) return null
    const { role, model, timestamp } = message as {
      role?: unknown
      model?: unknown
      timestamp?: unknown
    }
    // ASSISTANT ONLY, for the reason claude's reader gives: a readout has to
    // name a reply that actually ran at these settings.
    if (role !== 'assistant') return null
    if (typeof model !== 'string' || model.length === 0) return null
    // Pi carries an epoch-ms stamp on the message and an ISO one on the
    // record; either is fine, and the record's is the one every other harness
    // here uses, so it wins when both are present.
    const outer = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    const inner = typeof timestamp === 'number' ? timestamp : NaN
    const at = Number.isFinite(outer) ? outer : Number.isFinite(inner) ? inner : null
    const tuning: AgentTuning = { model, effort: null, at }
    return tuning
  },
}
