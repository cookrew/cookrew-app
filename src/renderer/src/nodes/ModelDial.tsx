// THE ONE MODEL LIST, drawn (owner 2026-11-04: merge MDL and RTE; the new
// agent's chip offers the same list). shared/model-pick.ts decides the rows,
// their order and which one the card stands on; this file only draws them.
//
// ModelList is the list itself — section headings and rows — and both chips
// draw it: the live agent's MDL dial below, and the new agent's menu
// (prompt/NewAgentTune.tsx), each with its own row look.

import { useLayoutEffect, useRef, useState } from 'react'
import { MODEL_SECTION_LABEL, modelChipText, visibleModelRows, type ModelRow } from '../../../shared/model-pick'

/**
 * Esc in a search box holding words clears the words; only the next Esc
 * closes the menu. The menus close on Esc in a capture listener, ahead of the
 * box, so they ask this first.
 */
export function searchHoldsEscape(e: { key: string; target: unknown }): boolean {
  const target = e.target as { classList?: { contains: (c: string) => boolean }; value?: unknown } | null
  return e.key === 'Escape' && target?.classList?.contains('cr-model-search') === true && typeof target.value === 'string' && target.value !== ''
}

/** A list this long gets the search box (and the fold); a short one shows whole. */
const SEARCH_FROM = 12

/**
 * Open a long list on the row it stands on (QA 2026-11-04: 84 rows, the
 * current one out of sight). Only the list scrolls: scrollIntoView would
 * also move whatever holds it, and here that is the zoom's scene.
 */
export function centerCurrent(container: HTMLElement | null): void {
  const row = container?.querySelector<HTMLElement>('[data-current="true"]')
  if (!container || !row) return
  const box = container.getBoundingClientRect()
  const at = row.getBoundingClientRect()
  container.scrollTop += at.top - box.top - (box.height - at.height) / 2
}

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

export function ModelList({ rows: all, current, asked = null, disabled = false, onPick, onMouseDown, look = 'rail' }: ModelListProps): React.JSX.Element {
  // FOLDED OR SEARCHED (owner 2026-11-04): a long catalog shows its newest
  // rows, "N more" unfolds it, and the box searches every row.
  const searchable = all.length > SEARCH_FROM
  const [query, setQuery] = useState('')
  const [unfolded, setUnfolded] = useState(false)
  const { rows, hidden } = searchable ? visibleModelRows(all, { query, all: unfolded, keep: [current, asked] }) : { rows: all, hidden: 0 }
  const extra = look === 'rail' ? 'cr-tune-row cr-model-more' : 'cr-model-more'
  return (
    <>
      {searchable && (
        <span className="cr-model-search-row" role="presentation">
          <input
            type="search"
            className="cr-model-search"
            placeholder="search models"
            aria-label="Search models"
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // The box's own keys: never the zoom's ("/" opens the board), the
              // prompt's, or the form's — Enter in a form would make an agent.
              if (e.key === 'Enter') {
                e.preventDefault()
                if (query.trim() && rows[0] && !disabled) onPick(rows[0].value)
              }
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                setQuery('')
              }
              e.stopPropagation()
            }}
          />
        </span>
      )}
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
              data-current={row.value === current ? 'true' : undefined}
              disabled={disabled}
              onMouseDown={onMouseDown}
              onClick={() => onPick(row.value)}
            >
              {row.label}
            </button>
          </span>
        )
      })}
      {query.trim() !== '' && rows.length === 0 && <span className="cr-model-none">no model matches “{query.trim()}”</span>}
      {query.trim() === '' && hidden > 0 && (
        <button type="button" className={extra} onMouseDown={onMouseDown} onClick={() => setUnfolded(true)}>
          {hidden} more models…
        </button>
      )}
      {query.trim() === '' && unfolded && (
        <button type="button" className={extra} onMouseDown={onMouseDown} onClick={() => setUnfolded(false)}>
          fewer
        </button>
      )}
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
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (model.open) centerCurrent(list.current)
  }, [model.open])
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
        <div className="cr-tune-list models" role="listbox" aria-label="Model" ref={list}>
          <ModelList rows={model.rows} current={model.current} asked={model.ask?.asked ?? null} disabled={locked !== null} onPick={model.onPick} onMouseDown={onMouseDown} />
          {caveat !== null && <div className="cr-tune-caveat">{caveat}</div>}
        </div>
      )}
    </div>
  )
}
