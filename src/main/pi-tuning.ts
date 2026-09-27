// Pi's half of the dials (shared/agent-tuning): BOTH SETTABLE, ONE CONFIRMABLE.
//
// Verified by driving a real pi in a PTY rather than read off its source:
//
//   /model qwen3.8-27b-q8   -> sets it, session only, prints the new model
//   /model not-a-model      -> OPENS A PICKER that swallows every keystroke
//   /thinking high          -> "Unknown thinking level. Available levels: off."
//   /thinking <supported>   -> sets it, session only
//
// Those two failure modes are not equally survivable, and that asymmetry is
// the whole design here. A bad THINKING level costs one error line. A bad
// MODEL strands the pane in a modal — the card still looks healthy and the
// agent is unreachable. So the model dial offers only what pi's own catalogs
// list (pi-catalog.ts), which makes a miss impossible rather than unlikely.
//
// READS: pi stamps each assistant message with the model that produced it
// (`message.model`) and NEVER records the thinking level. So `records` names
// the model alone, and a level ask reports as 'unrecorded' — sent, and
// checkable only in the pane. Pretending otherwise would mean a rail that
// waits forever for a confirmation that is never written.

import {
  piModelFor,
  piModels,
  piThinkingLevels,
  type PiCatalogOptions
} from './pi-catalog'
import type { AgentTuning, HarnessTuning } from '../shared/agent-tuning'

/** The record shape this reads, kept narrow — everything else is ignored. */
interface PiRecord {
  type?: unknown
  timestamp?: unknown
  message?: { role?: unknown; model?: unknown; timestamp?: unknown } | unknown
}

/** Test seam: point the catalog at a fixture directory. */
export function piTuningWith(options: PiCatalogOptions = {}): HarnessTuning {
  return {
    knobs: ['model', 'effort'],
    // The model is written onto every reply; the thinking level is written
    // nowhere. Only the first can settle an ask.
    records: ['model'],

    values: (knob, current) => {
      const models = piModels(options)
      if (models.length === 0) return []
      if (knob === 'model') return models.map((m) => m.ref)
      return piThinkingLevels(piModelFor(current?.model ?? null, models))
    },

    line: (knob, value) => {
      // Never compose a line for a value pi did not list: an unlisted model is
      // the modal-picker case, and this is the last place to stop it.
      const models = piModels(options)
      if (knob === 'model') {
        return models.some((m) => m.ref === value) ? `/model ${value}` : null
      }
      // Pi spells its effort dial `/thinking`, so the knob name is NOT the
      // command here — which is exactly why composing the line belongs to the
      // harness rather than to a shared `/${knob}` template.
      return /^[a-z]+$/.test(value) ? `/thinking ${value}` : null
    },

    read: piRead
  }
}

export const piTuning: HarnessTuning = piTuningWith()

/**
 * Pi's reading: the model off an assistant message, and no effort, because pi
 * records none. `tuningWords` then yields a model with a null effort and every
 * surface already draws whichever half it has.
 */
function piRead(record: unknown): AgentTuning | null {
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
  // Pi carries an epoch-ms stamp on the message and an ISO one on the record;
  // the record's is the one every other harness here uses, so it wins when
  // both are present.
  const outer = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  const inner = typeof timestamp === 'number' ? timestamp : NaN
  const at = Number.isFinite(outer) ? outer : Number.isFinite(inner) ? inner : null
  const tuning: AgentTuning = { model, effort: null, at }
  return tuning
}
