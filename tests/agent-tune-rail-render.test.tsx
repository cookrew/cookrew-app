// THE LEFT RAIL, PAINTED.
//
// The markup IS the picture, so the picture can be asserted: two chips wearing
// what the agent's last reply actually ran at, a list whose current row is the
// one the RECORD names, rows that stay readable but refuse the click while the
// agent is mid-turn, and — the one that matters — a chip that says out loud
// when a pick was typed and the next reply disagreed with it.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TuneRail } from '../src/renderer/src/nodes/TuneRail'
import {
  TUNE_COPY,
  tuneRailView,
  type AgentTuning,
  type AgentTuningState,
  type TuneAsk,
  type TuneRailView
} from '../src/shared/agent-tuning'

const T0 = 1_759_000_000_000

const CAVEAT = 'this also becomes the default every new agent boots on'

function view(input: {
  tuning?: AgentTuning | null
  asks?: TuneAsk[]
  harness?: string
  knobs?: ('model' | 'effort')[]
  phase?: 'idle' | 'thinking'
  remote?: boolean
}): TuneRailView {
  const state: AgentTuningState = {
    harness: input.harness ?? 'claude',
    knobs: input.knobs ?? ['model', 'effort'],
    tuning: input.tuning ?? null,
    asks: input.asks ?? [],
    caveat: (input.knobs ?? ['model', 'effort']).length > 0 ? CAVEAT : null
  }
  const built = tuneRailView({
    state,
    phase: input.phase ?? 'idle',
    remote: input.remote ?? false
  })
  if (built === null) throw new Error('this fixture must draw a rail')
  return built
}

function paint(v: TuneRailView, open: 'model' | 'effort' | null = null, error: string | null = null): string {
  return renderToStaticMarkup(
    <TuneRail view={v} open={open} onOpen={() => {}} onTurn={() => {}} error={error} />
  )
}

const RUNNING: AgentTuning = { model: 'claude-opus-5', effort: 'max', at: T0 }

describe('the rail wears what the agent is running on', () => {
  it('shows both dials, the model as its alias and the effort as its level', () => {
    const html = paint(view({ tuning: RUNNING }))
    expect(html).toContain('>MDL<')
    expect(html).toContain('>opus<')
    expect(html).toContain('>EFF<')
    expect(html).toContain('>max<')
  })

  it('carries the FULL recorded id in the accessible name, not the clipped chip', () => {
    // A 46px strip is where an id gets shortened; a screen reader is not
    // reading a 46px strip.
    const html = paint(view({ tuning: { model: 'gpt-4o-mini', effort: 'high', at: T0 } }))
    expect(html).toContain('aria-label="Model: gpt-4o-mini"')
  })

  it('says it knows nothing before the first reply instead of guessing', () => {
    const html = paint(view({}), 'model')
    expect(html).toContain('aria-label="Model: not recorded yet"')
    expect(html).toContain(TUNE_COPY.unread)
    expect(html).not.toContain('aria-selected="true"')
  })
})

describe('the open list', () => {
  it('ticks the row the record names', () => {
    const html = paint(view({ tuning: RUNNING }), 'model')
    expect(html).toContain('<button type="button" role="option" aria-selected="true" class="cr-tune-row current"')
    // Exactly one row can be current, or the rail is claiming two models.
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
  })

  it('offers aliases, never a pinned id', () => {
    const html = paint(view({ tuning: RUNNING }), 'model')
    for (const alias of ['fable', 'opus', 'sonnet', 'haiku']) expect(html).toContain(`>${alias}<`)
    expect(html).not.toContain('claude-opus-5<')
  })

  it('offers every effort level the record can confirm, and no others', () => {
    const html = paint(view({ tuning: RUNNING }), 'effort')
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) expect(html).toContain(`>${level}<`)
    expect(html).not.toContain('>auto<')
    expect(html).not.toContain('>ultracode<')
  })
})

describe('an ask that has not been answered', () => {
  it('flags the chip with what was asked for while it waits', () => {
    const html = paint(
      view({ tuning: RUNNING, asks: [{ knob: 'model', value: 'sonnet', at: T0 }] }),
      'model'
    )
    expect(html).toContain('class="cr-tune-chip pending"')
    expect(html).toContain('sonnet')
    expect(html).toContain(TUNE_COPY.pending)
    // The chip still reads the model that is actually answering.
    expect(html).toContain('>opus<')
  })

  it('says the pick did not take when a later reply disagrees', () => {
    // The 2026-08-06 fingerprint: typed, accepted by the TUI, and the agent
    // kept answering on the model it already had.
    const html = paint(
      view({
        tuning: { ...RUNNING, at: T0 + 1 },
        asks: [{ knob: 'model', value: 'haiku', at: T0 }]
      }),
      'model'
    )
    expect(html).toContain('class="cr-tune-chip refused"')
    expect(html).toContain(TUNE_COPY.refused)
  })
})

describe('what picking also does', () => {
  it('states it in the open list, where the click is about to happen', () => {
    expect(paint(view({ tuning: RUNNING }), 'model')).toContain(CAVEAT)
  })

  it('does not put it in the rail at rest', () => {
    // A standing warning on a 46px strip is furniture; a warning under the
    // row you are about to click is a warning.
    expect(paint(view({ tuning: RUNNING }))).not.toContain(CAVEAT)
  })
})

describe('when the dials may not be turned', () => {
  it('keeps the rows readable and refuses the click mid-turn', () => {
    const html = paint(view({ tuning: RUNNING, phase: 'thinking' }), 'effort')
    expect(html).toContain(TUNE_COPY.busy)
    expect(html.match(/disabled=""/g)).toHaveLength(5)
    // Readable: the readout is why someone zoomed in.
    expect(html).toContain('>max<')
  })

  it('says whose session it is for an imported card', () => {
    const html = paint(view({ tuning: RUNNING, remote: true }))
    expect(html).toContain(TUNE_COPY.remote)
  })

  it('draws no dials for a harness that has none, only where they live', () => {
    const html = paint(view({ harness: 'codex', knobs: [] }))
    expect(html).toContain(TUNE_COPY.noDials('codex'))
    expect(html).not.toContain('cr-tune-chip')
  })

  it('shows a refusal from the pane as an alert', () => {
    const html = paint(view({ tuning: RUNNING }), null, 'the input box is not free')
    expect(html).toContain('role="alert"')
    expect(html).toContain('the input box is not free')
  })
})
