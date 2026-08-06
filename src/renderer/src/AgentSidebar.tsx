import { useCallback, useEffect, useMemo, useState } from 'react'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { AgentRow } from './AgentRow'
import { buildAgentRows, type AgentRow as Row } from './agent-rows'
import { hasRegistry, useRoster } from './agent-registry'
import { recoverEligible, recoverErrorToast, recoverToastFor, type RecoverToast } from './recover'
import { useCanvasUi } from './canvas-ui'
import { RAIL_W, DEFAULT_W, nearestLevel, nextLevel, revealFor } from './sidebar-width'
import './agent-sidebar.css'

/** How long the recover result toast lingers before auto-dismissing. */
const RECOVER_TOAST_MS = 5000
/** Remembered across sessions so the sidebar opens the way you left it. */
const WIDTH_KEY = 'cookrew-agents-width'

let warnedNoRecover = false

function storedWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY)
    return raw ? nearestLevel(Number(raw)) : DEFAULT_W
  } catch {
    return DEFAULT_W
  }
}

/**
 * The agents sidebar: every teammate across every workspace, beside the canvas
 * instead of on top of it. Replaces the ALL AGENTS modal, whose scrim meant you
 * could read the roster or watch the canvas but never both.
 *
 * Width IS the level. Drag the edge and identity fades in, then the turn grows
 * in — one continuous motion, no mode switch. Clicking a row does not expand
 * it: it zooms the canvas to that terminal, which already owns the trace
 * reader, the checkpoint rail and fork/restore.
 */
export function AgentSidebar({ onClose }: { onClose: () => void }): React.JSX.Element {
  const roster = useRoster()
  const { activities, zoomToNode } = useCanvasUi()
  const [width, setWidth] = useState(storedWidth)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [showQuiet, setShowQuiet] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [recovering, setRecovering] = useState<string | null>(null)
  const [toast, setToast] = useState<RecoverToast | null>(null)
  // One clock for every relative label, ticking a minute at a time — 228 rows
  // must not each own a timer.
  const [now, setNow] = useState(() => Date.now())

  const canRecover = typeof cookrew().recoverAgent === 'function'
  if (!canRecover && !warnedNoRecover) {
    warnedNoRecover = true
    console.error('[agents] recoverAgent missing on this bridge — RECOVER hidden (older build?)')
  }

  const { live, quiet, workspaces } = useMemo(
    () => buildAgentRows({ roster, activities, now, workspaceId }),
    [roster, activities, now, workspaceId],
  )

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), RECOVER_TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  const applyWidth = useCallback((next: number) => {
    setWidth(next)
    try {
      window.localStorage.setItem(WIDTH_KEY, String(next))
    } catch {
      // private mode / denied storage — the level simply stops persisting
    }
  }, [])

  // ONE control, three states: rail → info → trace → rail. The panel does not
  // resize; the reveal ramps turn each step into a grow-in, not a jump.
  const cycle = useCallback(() => applyWidth(nextLevel(width)), [width, applyWidth])

  // ⌘\ / Ctrl+\ steps it, the shortcut every editor uses for the side panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        cycle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cycle])

  // A row click is a handoff, not an expand: select here, zoom there.
  const open = (row: Row): void => {
    setSelected(row.id)
    if (row.active) zoomToNode(row.id)
  }

  const recover = (row: Row): void => {
    const fn = cookrew().recoverAgent
    if (!fn || recovering !== null) return
    setRecovering(row.id)
    void fn(row.id)
      .then((result) => setToast(recoverToastFor(result)))
      .catch((error: unknown) =>
        setToast(recoverErrorToast(error instanceof Error ? error.message : String(error))),
      )
      .finally(() => setRecovering(null))
  }

  const rail = width <= RAIL_W
  const activeCount = live.filter((r) => r.phase === 'working' || r.phase === 'waiting').length

  return (
    <aside
      className={`ags${rail ? ' rail' : ''}`}
      style={{
        ['--ags-w' as string]: `${width}px`,
        ['--ags-reveal' as string]: String(revealFor(width).turn),
        ['--ags-reveal-id' as string]: String(revealFor(width).identity),
      }}
    >
      <div className="tf-head ags-head">
        <button
          className="cr-btn sm icon ags-cycle"
          title={rail ? 'Show agents (⌘\\)' : 'Next view (⌘\\)'}
          onClick={cycle}
        >
          <CrIcon name={rail ? 'next' : 'prev'} />
        </button>
        <span className="tf-title ags-title">ALL AGENTS</span>
        <span className="ags-count">
          {activeCount} active · {roster.length} total
        </span>
        <button className="cr-btn sm icon tf-close" title="Close" onClick={onClose}>
          <CrIcon name="close" />
        </button>
      </div>

      {!hasRegistry() && (
        <div className="ags-banner">REGISTRY API NOT WIRED — SHOWING THE ACTIVE WORKSPACE ONLY</div>
      )}

      {workspaces.length > 1 && (
        <div className="ags-filters">
          <button
            className={`cr-chip clickable${workspaceId === null ? ' amber' : ''}`}
            onClick={() => setWorkspaceId(null)}
          >
            ALL {roster.length}
          </button>
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              className={`cr-chip clickable${workspaceId === ws.id ? ' amber' : ''}`}
              title={ws.name}
              onClick={() => setWorkspaceId(workspaceId === ws.id ? null : ws.id)}
            >
              {ws.name} {ws.total}
            </button>
          ))}
        </div>
      )}

      <div className="ags-list">
        {live.length === 0 && quiet.length === 0 && <div className="ags-empty">No agents yet.</div>}
        {live.map((row) => (
          <AgentRow
            key={row.id}
            row={row}
            now={now}
            selected={selected === row.id}
            recovering={recovering === row.id}
            canRecover={canRecover && recoverEligible({ ...row, active: row.active })}
            onOpen={open}
            onRecover={recover}
          />
        ))}

        {quiet.length > 0 &&
          (showQuiet ? (
            quiet.map((row) => (
              <AgentRow
                key={row.id}
                row={row}
                now={now}
                selected={selected === row.id}
                recovering={recovering === row.id}
                canRecover={canRecover && recoverEligible({ ...row, active: row.active })}
                onOpen={open}
                onRecover={recover}
              />
            ))
          ) : (
            <button className="ags-quiet" onClick={() => setShowQuiet(true)}>
              + {quiet.length} QUIET · SHOW
            </button>
          ))}
        {showQuiet && quiet.length > 0 && (
          <button className="ags-quiet" onClick={() => setShowQuiet(false)}>
            HIDE {quiet.length} QUIET
          </button>
        )}
      </div>

      {toast && (
        <div className="ags-toast" data-tone={toast.tone} role="status" aria-live="polite">
          {toast.text}
        </div>
      )}
    </aside>
  )
}
