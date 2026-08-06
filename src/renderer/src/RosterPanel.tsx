import { useEffect, useMemo, useState } from 'react'
import { cookrew } from './api'
import { CrIcon } from './icons'
import { AgentAvatar } from './nodes/AgentAvatar'
import { RoleAvatar } from './nodes/RoleAvatar'
import { hasRegistry, useRoster, type AgentRegistryEntry } from './agent-registry'
import { AgentRow } from './AgentRow'
import { buildAgentRows, type AgentRow as Row } from './agent-rows'
import { useCanvasUi } from './canvas-ui'
import { recoverEligible, recoverErrorToast, recoverToastFor, type RecoverToast } from './recover'
import { dirLabel } from './workspace-v2'
import './agent-roster.css'

/** Once-only loud warn when the bridge lacks recoverAgent. */
let warnedNoRecover = false

/** How long the recover result toast lingers before auto-dismissing. */
const RECOVER_TOAST_MS = 5000

/**
 * Global agent roster (note item 2): every teammate across ALL workspaces,
 * grouped by workspace with active/inactive flags — so a switch or reboot
 * never hides the crew. Fed by the registry adapter (real API when present,
 * mock from the active workspace otherwise). Phone-friendly sheet. Fresco
 * owns visual polish; this owns structure + data.
 */
export function RosterPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const roster = useRoster()
  const { activities, zoomToNode } = useCanvasUi()
  const [showQuiet, setShowQuiet] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  // One clock for every relative label — 228 rows must not each own a timer.
  const [now, setNow] = useState(() => Date.now())
  const { live, quiet } = useMemo(
    () => buildAgentRows({ roster, activities, now }),
    [roster, activities, now],
  )
  const activeCount = roster.filter((a) => a.active).length
  /** Id of the row whose recover is in flight (disables its button). */
  const [recovering, setRecovering] = useState<string | null>(null)
  /** Transient recover-result toast (ok / defer / warn / error). */
  const [toast, setToast] = useState<RecoverToast | null>(null)
  // LIVE api only (never mocked): the button renders once the bridge has it —
  // both IPC and the phone remote expose recoverAgent (api/remote parity).
  const canRecover = typeof cookrew().recoverAgent === 'function'
  if (!canRecover && !warnedNoRecover) {
    // Loud-absent-bridge rule: a missing op degrades visibly in the console,
    // never silently (the listTraceIndex lesson).
    warnedNoRecover = true
    console.error('[roster] recoverAgent missing on this bridge — RECOVER hidden (older build?)')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  // Auto-dismiss the recover toast.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), RECOVER_TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  // ONE-TAP recover (Conductor ruling: no confirm sheet — recover is
  // non-destructive + reversible). Result → toast, mapped honestly.
  // A row click is a handoff, not an expand: select here, zoom there. The
  // canvas already owns the trace reader, the checkpoint rail and fork.
  const open = (row: Row): void => {
    setSelected(row.id)
    if (row.active) {
      zoomToNode(row.id)
      onClose()
    }
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

  return (
    <div className="tf-scrim" onClick={onClose}>
      <div className="tf-panel roster-panel" onClick={(e) => e.stopPropagation()}>
        <div className="tf-head">
          <CrIcon name="agent" />
          <span className="tf-title">ALL AGENTS</span>
          <span className="roster-count">
            {activeCount} active · {roster.length} total
          </span>
          <button className="cr-btn sm icon tf-close" title="Close" onClick={onClose}>
            <CrIcon name="close" />
          </button>
        </div>

        {!hasRegistry() && (
          <div className="tf-banner">
            REGISTRY API NOT WIRED YET — showing the active workspace only; the cross-workspace
            roster lands with Forge&apos;s registry.
          </div>
        )}

        {roster.length === 0 ? (
          <div className="tf-role-note">No agents yet.</div>
        ) : (
          <div className="roster-list">
            {live.map((row) => (
              <AgentRow
                key={row.id}
                row={row}
                now={now}
                selected={selected === row.id}
                recovering={recovering === row.id}
                canRecover={canRecover && recoverEligible(row)}
                onOpen={open}
                onRecover={recover}
              />
            ))}

            {/* The 228 collapse: agents that have never run a turn carry no
                information, so they fold behind one row instead of filling
                the panel. */}
            {quiet.length > 0 && (
              <>
                {showQuiet &&
                  quiet.map((row) => (
                    <AgentRow
                      key={row.id}
                      row={row}
                      now={now}
                      selected={selected === row.id}
                      recovering={recovering === row.id}
                      canRecover={canRecover && recoverEligible(row)}
                      onOpen={open}
                      onRecover={recover}
                    />
                  ))}
                <button className="roster-quiet" onClick={() => setShowQuiet(!showQuiet)}>
                  {showQuiet ? `HIDE ${quiet.length} QUIET` : `+ ${quiet.length} QUIET · SHOW`}
                </button>
              </>
            )}
          </div>
        )}

        {/* Recover result toast (agent-recover): honest mapping of the API
            result — ok / deferred-boot / legacy best-effort / error. */}
        {toast && (
          <div className="roster-toast" data-tone={toast.tone} role="status" aria-live="polite">
            {toast.text}
          </div>
        )}
      </div>
    </div>
  )
}
