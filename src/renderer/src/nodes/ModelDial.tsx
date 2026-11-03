// THE ONE MODEL LIST, drawn (owner 2026-11-04: merge MDL and RTE; the new
// agent's chip offers the same list). shared/model-pick.ts decides the rows,
// their order and which one the card stands on; this file only draws them.
//
// ModelList is the list itself — section headings and rows — and both chips
// draw it: the live agent's MDL dial below, and the new agent's menu
// (prompt/NewAgentTune.tsx), each with its own row look.

import { MODEL_SECTION_LABEL, modelChipText, type ModelRow } from '../../../shared/model-pick'

export interface ModelListProps {
  rows: readonly ModelRow[]
  /** The row the card stands on (or the new agent's pick). */
  current: string | null
  /** An unsettled ask, marked on its row. */
  asked?: string | null
  disabled?: boolean
  onPick: (value: string) => void
  onMouseDown?: (e: React.MouseEvent) => void
  /** How a row is drawn: the rail's option rows, or the prompt menu's radio items. */
  look?: 'rail' | 'menu'
}

export function ModelList({ rows, current, asked = null, disabled = false, onPick, onMouseDown, look = 'rail' }: ModelListProps): React.JSX.Element {
  return (
    <>
      {rows.map((row, i) => {
        const heading = i === 0 || rows[i - 1].section !== row.section
        const state = row.value === asked ? 'asked' : row.value === current ? 'current' : 'plain'
        return (
          <span key={row.value} className="cr-model-row-wrap" role="presentation">
            {heading && (
              <span className={look === 'menu' ? 'cr-prompt-menu-family cr-model-section' : 'cr-tune-section'} role="separator">
                {MODEL_SECTION_LABEL[row.section]}
              </span>
            )}
            <button
              type="button"
              role={look === 'menu' ? 'menuitemradio' : 'option'}
              aria-selected={look === 'rail' ? row.value === current : undefined}
              aria-checked={look === 'menu' ? row.value === current : undefined}
              className={look === 'rail' ? `cr-tune-row ${state}${row.section === 'group' ? ' group' : ''}` : undefined}
              title={row.value}
              disabled={disabled}
              onMouseDown={onMouseDown}
              onClick={() => onPick(row.value)}
            >
              {row.label}
            </button>
          </span>
        )
      })}
    </>
  )
}

export interface ModelDialProps {
  rows: readonly ModelRow[]
  current: string | null
  /** The model the last reply recorded, verbatim: what the chip says when no row is current. */
  reading: string | null
  ask: { asked: string; outcome: 'pending' | 'refused' } | null
  /** This turn's model · tokens · cost, from the route (route-view.routeDialLines). */
  turn: string | null
  /** "applies on restart", "gateway offline" … */
  note: string | null
  open: boolean
  onOpen: (open: boolean) => void
  onPick: (value: string) => void
}

/** The live agent's MDL dial: the one list in the rail's chip. */
export function ModelDial({
  model,
  locked,
  caveat,
  onMouseDown
}: {
  model: ModelDialProps
  locked: string | null
  caveat: string | null
  onMouseDown?: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const shown = model.current !== null ? modelChipText(model.current) : model.reading
  const reading = shown ?? 'not recorded yet'
  return (
    <div className={`cr-tune-dial${model.open ? ' open' : ''}`} data-knob="model">
      <button
        type="button"
        className={`cr-tune-chip${model.ask !== null ? ` ${model.ask.outcome}` : ''}`}
        aria-expanded={model.open}
        aria-label={`Model: ${reading}`}
        title={[`Model: ${reading}`, model.turn, model.note].filter(Boolean).join(' · ')}
        onMouseDown={onMouseDown}
        onClick={() => model.onOpen(!model.open)}
      >
        <span className="cr-tune-k">MDL</span>
        <span className="cr-tune-v">{shown ?? '—'}</span>
        {model.ask !== null && (
          <span className="cr-tune-flag">{`${model.ask.outcome === 'pending' ? '→' : '!'} ${modelChipText(model.ask.asked)}`}</span>
        )}
        {model.ask === null && model.turn !== null && <span className="cr-tune-flag cr-tune-turn">{model.turn.replace('this turn → ', '→ ')}</span>}
        {model.note !== null && <span className="cr-tune-flag">{model.note}</span>}
      </button>
      {model.open && (
        <div className="cr-tune-list models" role="listbox" aria-label="Model">
          <ModelList rows={model.rows} current={model.current} asked={model.ask?.asked ?? null} disabled={locked !== null} onPick={model.onPick} onMouseDown={onMouseDown} />
          {caveat !== null && <div className="cr-tune-caveat">{caveat}</div>}
        </div>
      )}
    </div>
  )
}
