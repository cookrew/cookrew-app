// THE ONE TUNE BUTTON ON THE BAR (owner 2026-10-31: "model switch, effort
// switch, route switch in one").
//
// The bar shows what the agent runs on — `claude-opus-5-5 · high` — as one
// button. Opening it drops the whole rail (MDL, EFF, RTE) as rows, each still
// its own dial with its own list, so every pick is still open → pick. It
// decides nothing: the rail does (TuneRail, shared/agent-tuning).

import { useEffect, useRef, useState } from 'react'
import { TuneRail, type TuneRailProps } from './TuneRail'

export interface TuneMenuProps extends Omit<TuneRailProps, 'bar' | 'menu' | 'knobs'> {
  summary: { model: string; effort: string | null }
}

export function TuneMenu({ summary, ...rail }: TuneMenuProps): React.JSX.Element {
  const [shown, setShown] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const { onOpen } = rail

  useEffect(() => {
    if (!shown) return
    const close = (): void => {
      setShown(false)
      onOpen(null)
    }
    const onPointer = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // The menu's Esc, not the zoom-back behind it.
      e.stopPropagation()
      close()
    }
    // Capture: the stage swallows pointerdown before it bubbles.
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [shown, onOpen])

  const label = summary.effort !== null ? `${summary.model} · ${summary.effort}` : summary.model
  return (
    <div className={`cr-tune-menu${shown ? ' open' : ''}`} ref={root}>
      <button
        type="button"
        className="cr-tune-menu-btn"
        aria-expanded={shown}
        aria-haspopup="true"
        aria-label={`Model, effort and route: ${label}`}
        title={`Model, effort and route — ${label}`}
        onMouseDown={rail.onMouseDown}
        onClick={() => {
          setShown((now) => !now)
          if (shown) onOpen(null)
        }}
      >
        <span className="cr-tune-menu-model">{summary.model}</span>
        {summary.effort !== null && <span className="cr-tune-menu-effort">{summary.effort}</span>}
        <span className="cr-tune-menu-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {shown && (
        <div className="cr-tune-menu-panel">
          <TuneRail {...rail} menu />
        </div>
      )}
    </div>
  )
}
