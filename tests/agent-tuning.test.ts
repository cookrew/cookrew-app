// THE DIALS, DECIDED (shared/agent-tuning).
//
// Three claims are load-bearing and each one is a refusal the rail makes on
// the user's behalf:
//   1. the offered models are ALIASES, because a pinned id bricked half the
//      fleet on 2026-08-06 and an alias cannot name a model the agent's own
//      binary lacks;
//   2. ASKED is not SET — a typed slash command is not a transaction, so the
//      rail waits for the harness's own record to agree;
//   3. a reply that lands AFTER the ask and still reads the old value is a
//      REFUSAL, said out loud, not a number quietly left on screen.

import { describe, expect, it } from 'vitest'
import {
  EFFORT_LEVELS,
  MODEL_ALIASES,
  TUNE_COPY,
  askOutcome,
  chipText,
  dialReading,
  inputRefusal,
  isTuneKnob,
  liveAsk,
  modelAliasOf,
  tuneLine,
  tuneRailView,
  tuneValueOk,
  tuningTag,
  tuningTitle,
  tuningWords,
  type AgentTuning,
  type AgentTuningState,
  type TuneAsk
} from '../src/shared/agent-tuning'

const T0 = 1_759_000_000_000

function state(over: Partial<AgentTuningState> = {}): AgentTuningState {
  return {
    harness: 'claude',
    knobs: ['model', 'effort'],
    records: ['model', 'effort'],
    tuning: null,
    asks: [],
    caveat: null,
    ...over
  }
}

function tuning(over: Partial<AgentTuning> = {}): AgentTuning {
  return { model: 'claude-opus-5', effort: 'max', at: T0, ...over }
}

function ask(over: Partial<TuneAsk> = {}): TuneAsk {
  return { knob: 'model', value: 'sonnet', at: T0, ...over }
}

describe('what a dial offers', () => {
  it('offers model ALIASES only — never a pinned id', () => {
    // The 2026-08-06 incident: a picker that wrote `claude-opus-4-8[1m]` into
    // agents whose binary predated it killed every one of them. An alias is
    // resolved by the binary the agent actually booted with.
    for (const alias of MODEL_ALIASES) {
      expect(alias, `${alias} looks like a pinned id`).not.toMatch(/\d/)
      expect(alias).not.toContain('claude-')
    }
  })

  it('offers only effort levels the record can confirm', () => {
    // `auto` and `ultracode` both resolve to some other level before they are
    // written down, so a rail showing them could never settle an ask.
    expect(EFFORT_LEVELS).not.toContain('auto')
    expect(EFFORT_LEVELS).not.toContain('ultracode')
    expect([...EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('refuses a knob name it does not know, because the name reaches a PTY', () => {
    expect(isTuneKnob('model')).toBe(true)
    expect(isTuneKnob('effort')).toBe(true)
    expect(isTuneKnob('permissions')).toBe(false)
  })

  it('refuses a value it does not offer', () => {
    expect(tuneValueOk('model', 'opus')).toBe(true)
    expect(tuneValueOk('model', 'claude-opus-4-8')).toBe(false)
    expect(tuneValueOk('effort', 'max')).toBe(true)
    expect(tuneValueOk('effort', 'ludicrous')).toBe(false)
  })

  it('spells the line the way the harness reads it', () => {
    expect(tuneLine('model', 'opus')).toBe('/model opus')
    expect(tuneLine('effort', 'xhigh')).toBe('/effort xhigh')
  })
})

describe('reading a recorded model back', () => {
  it('maps the ids the harness actually writes to their alias', () => {
    expect(modelAliasOf('claude-opus-5')).toBe('opus')
    expect(modelAliasOf('claude-fable-5-1')).toBe('fable')
    expect(modelAliasOf('claude-sonnet-5')).toBe('sonnet')
    expect(modelAliasOf('claude-haiku-4-5-20251001')).toBe('haiku')
  })

  it('matches SEGMENTS, so opusplan is not opus', () => {
    // A substring test would say it is, and then the rail would tick the
    // `opus` row for an agent running a different mode entirely.
    expect(modelAliasOf('opusplan')).toBeNull()
    expect(modelAliasOf('claude-opusplan-5')).toBeNull()
  })

  it('has no alias for a model outside the offered set', () => {
    expect(modelAliasOf('anthropic.claude-3-5-sonnet-v2:0')).toBe('sonnet')
    expect(modelAliasOf('gpt-4o')).toBeNull()
  })

  it('compares model rows by alias and effort rows by the level itself', () => {
    expect(dialReading('model', tuning())).toBe('opus')
    expect(dialReading('effort', tuning())).toBe('max')
    expect(dialReading('model', null)).toBeNull()
  })
})

describe('an ask against the record', () => {
  it('is SETTLED once the record agrees', () => {
    expect(askOutcome(ask({ value: 'opus' }), tuning())).toBe('settled')
    expect(askOutcome(ask({ knob: 'effort', value: 'max' }), tuning())).toBe('settled')
  })

  it('is PENDING while no reply has landed since it was typed', () => {
    // Same-millisecond record counts as "before": the harness cannot have
    // answered a line that was typed at the instant it wrote the record.
    expect(askOutcome(ask({ at: T0 }), tuning({ at: T0 }))).toBe('pending')
    expect(askOutcome(ask({ at: T0 }), tuning({ at: T0 - 1 }))).toBe('pending')
    expect(askOutcome(ask(), null)).toBe('pending')
    expect(askOutcome(ask(), tuning({ at: null }))).toBe('pending')
  })

  it('is REFUSED when a later reply still reads the old value', () => {
    // This is the bricking fingerprint: the pick was typed, the agent kept
    // answering, and it kept answering on the model it already had.
    expect(askOutcome(ask({ at: T0 }), tuning({ at: T0 + 1 }))).toBe('refused')
  })

  it('takes the NEWEST ask per knob and ignores the other knob', () => {
    const asks = [
      ask({ knob: 'effort', value: 'low', at: T0 }),
      ask({ value: 'haiku', at: T0 + 1 }),
      ask({ value: 'sonnet', at: T0 + 2 })
    ]
    expect(liveAsk('model', asks, tuning({ at: T0 }))?.ask.value).toBe('sonnet')
    expect(liveAsk('effort', asks, tuning({ at: T0 }))?.ask.value).toBe('low')
  })

  it('goes quiet once the newest ask settles, even with older ones behind it', () => {
    const asks = [ask({ value: 'haiku', at: T0 }), ask({ value: 'opus', at: T0 + 1 })]
    expect(liveAsk('model', asks, tuning({ at: T0 + 2 }))).toBeNull()
  })
})

describe('a knob the harness never writes down', () => {
  it('reports the ask as SENT and uncheckable, not pending forever', () => {
    // Pi accepts a thinking level and records none. 'pending' would be a
    // promise that never resolves; 'refused' would be an accusation nothing
    // supports. Both would be lies with different shapes.
    const asks = [ask({ knob: 'effort', value: 'high', at: T0 })]
    expect(askOutcome(asks[0], tuning({ at: T0 + 5000 }), ['model'])).toBe('unrecorded')
    expect(liveAsk('effort', asks, tuning({ at: T0 + 5000 }), ['model'])?.outcome).toBe('unrecorded')
  })

  it('still settles and refuses normally for a knob that IS written down', () => {
    const asks = [ask({ value: 'opus', at: T0 })]
    expect(askOutcome(asks[0], tuning(), ['model'])).toBe('settled')
    expect(askOutcome(ask({ value: 'haiku', at: T0 }), tuning({ at: T0 + 1 }), ['model'])).toBe('refused')
  })

  it('says so on the dial even before anything is asked', () => {
    const view = tuneRailView({
      state: state({ tuning: tuning(), records: ['model'] }),
      phase: 'idle',
      remote: false
    })
    const effort = view!.dials.find((d) => d.knob === 'effort')
    expect(effort?.note).toBe(TUNE_COPY.unrecorded)
    // The model dial is unaffected — it is recorded.
    expect(view!.dials.find((d) => d.knob === 'model')?.note).toBeNull()
  })
})

describe('a harness that names its own values', () => {
  it('draws the harness\u2019s rows, not the shared defaults', () => {
    // Pi's models come from its catalogs; offering anything else opens a
    // picker that swallows the pane's input.
    const view = tuneRailView({
      state: state({
        harness: 'pi',
        tuning: { model: 'qwen3.8-27b-q8', effort: null, at: T0 },
        records: ['model'],
        choices: { model: ['ifunk/k3', 'qwen-local/qwen3.8-27b-q8'], effort: ['off'] }
      }),
      phase: 'idle',
      remote: false
    })
    expect(view!.dials[0].rows.map((r) => r.value)).toEqual([
      'ifunk/k3',
      'qwen-local/qwen3.8-27b-q8'
    ])
    expect(view!.dials[1].rows.map((r) => r.value)).toEqual(['off'])
    // No claude alias leaked in.
    expect(view!.dials[0].rows.some((r) => r.value === 'opus')).toBe(false)
  })

  it('falls back to the shared values when a harness names none', () => {
    const view = tuneRailView({ state: state({ tuning: tuning() }), phase: 'idle', remote: false })
    expect(view!.dials[0].rows.map((r) => r.value)).toEqual([...MODEL_ALIASES])
  })
})

describe('the rail as a whole', () => {
  it('is not drawn at all for a card with no harness', () => {
    // A plain shell has no model and no effort; a dial reading "not
    // applicable" on every shell card is furniture.
    expect(tuneRailView({ state: state({ harness: null }), phase: 'idle', remote: false })).toBeNull()
    expect(tuneRailView({ state: null, phase: 'idle', remote: false })).toBeNull()
  })

  it('draws no dials but says where they live for a harness without them', () => {
    const view = tuneRailView({
      state: state({ harness: 'codex', knobs: [] }),
      phase: 'idle',
      remote: false
    })
    expect(view?.dials).toEqual([])
    expect(view?.locked).toBe(TUNE_COPY.noDials('codex'))
  })

  it('locks mid-turn, because typing into a running pane contaminates the box', () => {
    const view = tuneRailView({ state: state({ tuning: tuning() }), phase: 'thinking', remote: false })
    expect(view?.locked).toBe(TUNE_COPY.busy)
    // Still readable: the rows are the readout, not only the control.
    expect(view?.dials[0].rows).toHaveLength(MODEL_ALIASES.length)
  })

  it('locks a card that is a line into someone else’s app', () => {
    const view = tuneRailView({ state: state({ tuning: tuning() }), phase: 'idle', remote: true })
    expect(view?.locked).toBe(TUNE_COPY.remote)
  })

  it('ticks the row the record names, not the row that was asked for', () => {
    const view = tuneRailView({
      state: state({ tuning: tuning(), asks: [ask({ value: 'haiku', at: T0 })] }),
      phase: 'idle',
      remote: false
    })
    const model = view!.dials[0]
    expect(model.rows.find((r) => r.state === 'current')?.value).toBe('opus')
    expect(model.rows.find((r) => r.state === 'asked')?.value).toBe('haiku')
    expect(model.reading).toBe('claude-opus-5')
    expect(model.note).toBe(TUNE_COPY.pending)
  })

  it('says the ask did not take when a later reply disagrees', () => {
    const view = tuneRailView({
      state: state({ tuning: tuning({ at: T0 + 1 }), asks: [ask({ value: 'haiku', at: T0 })] }),
      phase: 'idle',
      remote: false
    })
    expect(view!.dials[0].outcome).toBe('refused')
    expect(view!.dials[0].note).toBe(TUNE_COPY.refused)
  })

  it('admits it knows nothing before the first reply', () => {
    const view = tuneRailView({ state: state(), phase: 'idle', remote: false })
    expect(view!.dials.map((d) => d.reading)).toEqual([null, null])
    expect(view!.dials[0].note).toBe(TUNE_COPY.unread)
    expect(view!.dials.every((d) => d.rows.every((r) => r.state === 'plain'))).toBe(true)
  })

  it('shows the alias on the chip, and an unmapped id verbatim', () => {
    const known = tuneRailView({ state: state({ tuning: tuning() }), phase: 'idle', remote: false })
    expect(chipText(known!.dials[0])).toBe('opus')
    expect(chipText(known!.dials[1])).toBe('max')

    const foreign = tuneRailView({
      state: state({ tuning: tuning({ model: 'gpt-4o' }) }),
      phase: 'idle',
      remote: false
    })
    // Never abbreviated into a name it does not have.
    expect(chipText(foreign!.dials[0])).toBe('gpt-4o')
    expect(foreign!.dials[0].current).toBeNull()
  })
})

describe('what picking also does', () => {
  it('carries the harness’s caveat, because a click is easier than a typed command', () => {
    const view = tuneRailView({
      state: state({ tuning: tuning(), caveat: 'this also becomes the default' }),
      phase: 'idle',
      remote: false
    })
    expect(view?.caveat).toBe('this also becomes the default')
  })

  it('drops it for a harness whose dials we do not turn', () => {
    const view = tuneRailView({
      state: state({ harness: 'codex', knobs: [], caveat: 'never mind' }),
      phase: 'idle',
      remote: false
    })
    expect(view?.caveat).toBeNull()
  })
})

describe('the tag every card view wears', () => {
  it('reads harness-shaped: the model then the effort', () => {
    expect(tuningTag(tuning())).toBe('opus max')
    expect(tuningTag({ model: 'gpt-6-astra', effort: 'high', at: T0 })).toBe('gpt-6-astra high')
  })

  it('abbreviates to the alias exactly as the rail chip does', () => {
    // One rule across every surface: a card saying `claude-opus-5` two pixels
    // from a rail saying `opus` is two answers to one question.
    expect(tuningTag(tuning())).toBe('opus max')
    expect(tuningTitle(tuning())).toBe('claude-opus-5 · effort max')
  })

  it('hands the two parts out separately for the narrow surfaces', () => {
    expect(tuningWords(tuning())).toEqual({ model: 'opus', effort: 'max' })
    expect(tuningWords({ model: 'gpt-6-astra', effort: 'high', at: T0 })).toEqual({
      model: 'gpt-6-astra',
      effort: 'high'
    })
    expect(tuningWords(null)).toEqual({ model: null, effort: null })
    // The one-line tag is COMPOSED from them, so the two can never disagree
    // about how a model is abbreviated.
    const words = tuningWords(tuning())
    expect(tuningTag(tuning())).toBe(`${words.model} ${words.effort}`)
  })

  it('is null when nothing is recorded, so no chip is drawn', () => {
    expect(tuningTag(null)).toBeNull()
    expect(tuningTag({ model: null, effort: null, at: null })).toBeNull()
    expect(tuningTitle(null)).toBeNull()
  })

  it('says whichever half it has when the other is missing', () => {
    expect(tuningTag({ model: 'gpt-6-astra', effort: null, at: T0 })).toBe('gpt-6-astra')
    expect(tuningTag({ model: null, effort: 'high', at: T0 })).toBe('high')
  })
})

describe('the input gate, said as a sentence', () => {
  it('translates the gate vocabulary for someone looking at a card', () => {
    expect(inputRefusal('preempt-failed')).toContain('mid-delivery')
    expect(inputRefusal('refused')).toContain('input box')
    expect(inputRefusal('refused')).not.toContain('lease')
  })
})
