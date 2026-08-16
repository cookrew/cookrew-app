import { useEffect, useRef, useState } from 'react'
import { cookrew } from './api'
import { CrIcon, type CrIconName } from './icons'
import { RoleAvatar } from './nodes/RoleAvatar'
import { coalesceIndex, eventMeta, kindFor, onEvent } from './event-log'
import './agent-roster.css'

/** How long a toast lingers after its last update before auto-dismissing. */
const DISMISS_MS = 5000
const EXIT_MS = 240

interface EventToast {
  key: number
  type: string
  workspaceId: string
  workspaceName: string
  entityName: string
  details?: string
  count: number
  lastAt: number
  leaving: boolean
}

/**
 * Global event-feed toast layer (observability-event-log-spec, projection A).
 * Mounted once at the top level, it subscribes to the global event stream and
 * shows a transient tag per lifecycle event — auto-dismiss ~5s. Non-active
 * workspace events are labelled `in <workspace>`. BURST COALESCING: events of
 * the same type + workspace within ~2s collapse into one grouped toast (a team
 * fork of 11 → "11 agents recruited in <ws>"). Fresco owns the visual polish.
 */
export function EventToastLayer(): React.JSX.Element {
  const [toasts, setToasts] = useState<EventToast[]>([])
  const seq = useRef(0)
  const [activeWs, setActiveWs] = useState<string | null>(null)

  // Track the active workspace name so events elsewhere get an `in <ws>` label.
  useEffect(() => {
    void cookrew().getWorkspace().then((s) => setActiveWs(s.name))
    return cookrew().onWorkspaceState((s) => setActiveWs(s.name))
  }, [])

  useEffect(() => {
    return onEvent((event) => {
      const now = nowMs()
      setToasts((prev) => {
        // Coalesce onto a live toast of the same type+workspace in the window.
        const idx = coalesceIndex(prev, event, now)
        if (idx >= 0) {
          const merged = [...prev]
          merged[idx] = { ...merged[idx], count: merged[idx].count + 1, lastAt: now }
          return merged
        }
        const toast: EventToast = {
          key: ++seq.current,
          type: event.type,
          workspaceId: event.workspaceId,
          workspaceName: event.workspaceName,
          entityName: event.entityName,
          details: event.details,
          count: 1,
          lastAt: now,
          leaving: false
        }
        return [toast, ...prev].slice(0, 5)
      })
    })
  }, [])

  // Age toasts out: mark leaving near the deadline, remove just after so the
  // slide-out animation plays.
  useEffect(() => {
    if (toasts.length === 0) return
    const timer = setInterval(() => {
      const now = nowMs()
      setToasts((prev) => {
        const next = prev
          .map((t) => (!t.leaving && now - t.lastAt >= DISMISS_MS - EXIT_MS ? { ...t, leaving: true } : t))
          .filter((t) => !(t.leaving && now - t.lastAt >= DISMISS_MS))
        return next.length === prev.length && next.every((t, i) => t === prev[i]) ? prev : next
      })
    }, 250)
    return () => clearInterval(timer)
  }, [toasts.length])

  const dismiss = (key: number): void => setToasts((prev) => prev.filter((t) => t.key !== key))

  return (
    <div className="spawn-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <EventToastCard
          key={toast.key}
          toast={toast}
          showWs={activeWs !== null && toast.workspaceName !== activeWs}
          onDismiss={() => dismiss(toast.key)}
        />
      ))}
    </div>
  )
}

function EventToastCard({
  toast,
  showWs,
  onDismiss
}: {
  toast: EventToast
  showWs: boolean
  onDismiss: () => void
}): React.JSX.Element {
  const meta = eventMeta(toast.type)
  const hatch = meta.hatch && toast.count === 1
  const primary =
    toast.count === 1
      ? `${toast.entityName} ${meta.verb}`
      : `${toast.count} ${meta.noun}s ${meta.verb}`

  return (
    <div
      className={`spawn-toast event-toast${toast.leaving ? ' leaving' : ''}${toast.count > 1 ? ' grouped' : ''}`}
      onClick={onDismiss}
      title="Dismiss"
    >
      {hatch ? (
        <span className="spawn-toast-hatch" aria-hidden="true">
          <RoleAvatar name={toast.entityName} className="spawn-toast-avatar" />
        </span>
      ) : (
        <span className="event-toast-glyph" data-kind={kindFor(toast.type)} aria-hidden="true">
          <CrIcon name={meta.icon as CrIconName} />
        </span>
      )}
      <div className="spawn-toast-body">
        <div className="spawn-toast-line">
          <span className="spawn-toast-hatchword">{meta.label.toUpperCase()}</span>
          <span className="spawn-toast-name">{primary}</span>
          {toast.count > 1 && <span className="event-toast-count">{toast.count}</span>}
        </div>
        <div className="spawn-toast-meta">
          {toast.details && <span className="event-toast-detail">{toast.details}</span>}
          {showWs && <span className="event-toast-ws">in {toast.workspaceName}</span>}
        </div>
      </div>
    </div>
  )
}

/** Date.now is fine in the renderer (browser), unlike workflow scripts. */
function nowMs(): number {
  return Date.now()
}
