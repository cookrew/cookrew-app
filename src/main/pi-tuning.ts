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
// READS: pi records MORE than it first appeared. Besides stamping each
// assistant message with the model that produced it, it writes a record the
// instant either dial moves:
//
//   {"type":"model_change","provider":"ifunk","modelId":"k3"}
//   {"type":"thinking_level_change","thinkingLevel":"off"}
//
// So BOTH knobs are confirmable — an earlier reading of this file said the
// thinking level was never recorded, which was simply wrong — and both read
// back immediately rather than waiting for the next reply. A `model_change`
// reports the PROVIDER-QUALIFIED ref, which is exactly the string `/model`
// accepts and the rows offer.

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
  provider?: unknown
  modelId?: unknown
  thinkingLevel?: unknown
  message?: { role?: unknown; model?: unknown; timestamp?: unknown } | unknown
}

/** Test seam: point the catalog at a fixture directory. */
export function piTuningWith(options: PiCatalogOptions = {}): HarnessTuning {
  return {
    knobs: ['model', 'effort'],
    // Both, via the change records above.
    records: ['model', 'effort'],

    /**
     * Deeper windows than the default, for the same reason codex needs them
     * and a different cause. Pi writes `thinking_level_change` when the level
     * MOVES — which for a session nobody has retuned means once, at the very
     * start. Measured across this machine's pi sessions: the level record sat
     * 512 KB to 3.5 MB back in files of the same size, so every pi card but
     * the smallest read its effort as unknown.
     *
     * The model is unaffected either way (every assistant message carries it);
     * this is what makes the OTHER dial readable. Paid once per file: the
     * cache then follows the appended bytes alone.
     */
    tailSteps: [64 * 1024, 512 * 1024, 4 * 1024 * 1024],

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
  const stampOf = (): number | null => {
    const parsed = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    return Number.isFinite(parsed) ? parsed : null
  }
  // THE CHANGE RECORDS: pi's own acknowledgment, written the moment a dial
  // moves, so the readout does not wait for the next reply. Each names one
  // dial and the scanner merges it over the other.
  if (entry.type === 'model_change') {
    const { provider, modelId } = entry as { provider?: unknown; modelId?: unknown }
    if (typeof modelId !== 'string' || modelId.length === 0) return null
    // Provider-qualified, because that is the string /model accepts and the
    // rows offer — an unqualified id would tick no row.
    const model = typeof provider === 'string' && provider.length > 0 ? `${provider}/${modelId}` : modelId
    return { model, effort: null, at: stampOf() }
  }
  if (entry.type === 'thinking_level_change') {
    const level = (entry as { thinkingLevel?: unknown }).thinkingLevel
    if (typeof level !== 'string' || level.length === 0) return null
    return { model: null, effort: level, at: stampOf() }
  }
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
