// THE BOARD, AS A SEARCH BOX (owner 2026-11-01). The board was a whole view
// behind ⋯, marked deprecated. It is back as the box at the top right, left of
// ⋯: focus it (or press /) and the board drops under it, every agent with its
// latest line; type and it narrows to who you remember, by name, task or
// anything said. Picking a row opens that agent and folds the board away.
//
// The board mounts only while the box is open, so its roster, tails and event
// log cost nothing at rest. On a phone the box is a magnifier the size of ⋯
// and opens across the bar.
//
// The panel is portalled to <body>: inside the bar it would share the bar's
// layer (50) and lie under the pets (55) that float over the stage's right edge.
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CrIcon } from './icons'
import type { WorkspaceState } from '../../shared/model'
import { boardActions, type BoardActionId } from './board-actions'

const RosterPanel = lazy(() => import('./RosterPanel').then((m) => ({ default: m.RosterPanel })))

/** Where a keystroke is already somebody's text, so `/` is a character there. */
const TYPING = 'input, textarea, select, [contenteditable="true"], .xterm'

interface BoardSearchProps {
  workspace: WorkspaceState | null
  activeWorkspaceId: string | null
  /** Agents waiting on you: a small count on the box while it is closed. */
  attentionCount: number
  /** What the search box can do besides find agents (board-actions.ts). */
  onAction?: (id: BoardActionId) => void
}

/** The panel hangs this far under the bar's bottom edge. */
const DROP_PX = 6

/** `/` focuses the box, unless the key is already going into some text. */
export function isBoardKey(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>, target: EventTarget | null): boolean {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return false
  const el = target as Element | null
  return !el?.closest?.(TYPING)
}

export function BoardSearch({ workspace, activeWorkspaceId, attentionCount, onAction }: BoardSearchProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  /** The bar's bottom edge, read on open and on resize: where the panel hangs. */
  const [top, setTop] = useState<number | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    input.current?.blur()
  }, [])

  // `/` from anywhere that is not a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isBoardKey(e, e.target)) return
      e.preventDefault()
      setOpen(true)
      input.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const actions = onAction ? boardActions(query) : []
  const run = (id: BoardActionId): void => {
    close()
    onAction?.(id)
  }

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const bar = root.current?.closest('.cr-header') ?? root.current
      if (bar) setTop(Math.round(bar.getBoundingClientRect().bottom) + DROP_PX)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) return
    // Capture: the stage's panes swallow a press before it bubbles.
    const onPointer = (e: PointerEvent): void => {
      const target = e.target as Node
      if (!root.current?.contains(target) && !pop.current?.contains(target)) close()
    }
    // Esc clears a query first, then folds the board. Stopped here so the
    // zoom does not also take a step out (ZoomView skips this box too).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (query && document.activeElement === input.current) setQuery('')
      else close()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, query, close])

  return (
    <div className={`cr-board-search${open ? ' open' : ''}`} ref={root}>
      <label className="cr-board-box" title="Search the board ( / )">
        <CrIcon name="search" />
        <input
          ref={input}
          className="cr-board-input"
          type="search"
          value={query}
          placeholder="Search agents, browsers, notes…"
          aria-label="Search the board"
          aria-expanded={open}
          aria-controls={open ? 'cr-board-pop' : undefined}
          autoComplete="off"
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && actions[0]) run(actions[0].id)
          }}
        />
        {!open && attentionCount > 0 && (
          <span className="cr-board-badge" title={`${attentionCount} waiting on you`}>
            {attentionCount}
          </span>
        )}
        {!open && <kbd className="cr-board-kbd">/</kbd>}
        {open && (
          <button
            type="button"
            className="cr-board-clear"
            aria-label={query ? 'Clear' : 'Close the board'}
            title={query ? 'Clear' : 'Close'}
            onClick={() => {
              if (query) {
                setQuery('')
                input.current?.focus()
              } else close()
            }}
          >
            <CrIcon name="close" />
          </button>
        )}
      </label>
      {open &&
        top !== null &&
        createPortal(
          <div className="cr-board-pop" id="cr-board-pop" ref={pop} style={{ top }}>
            {actions.length > 0 && (
              <div className="cr-board-actions">
                {actions.map((action) => (
                  <button type="button" key={action.id} className="cr-board-action" onClick={() => run(action.id)}>
                    <CrIcon name="plus" />
                    <b>{action.label}</b>
                    <span>{action.hint}</span>
                  </button>
                ))}
              </div>
            )}
            <Suspense fallback={<div className="cr-board-loading">Loading the board…</div>}>
              <RosterPanel
                workspace={workspace}
                activeWorkspaceId={activeWorkspaceId}
                query={query}
                onQueryChange={setQuery}
                variant="popover"
                onClose={close}
              />
            </Suspense>
          </div>,
          document.body
        )}
    </div>
  )
}
