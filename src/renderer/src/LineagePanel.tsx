import { useEffect, useState } from 'react'
import { cookrew } from './api'
import { CrIcon } from './icons'
import {
  fetchLineageSegments,
  traceRowLabel,
  type LineageSegmentRow
} from './transcript'

/**
 * EARLIER SESSIONS panel — the lineage expansion the boundary tick opens.
 *
 * An auto-compact rotation (or a /clear) starts a NEW session file; the rail
 * honestly shows only that file (checkpoint-session-alignment forbids mixing
 * segments into one numbering), so everything earlier lived nowhere a user
 * could reach. This panel is where it lives now: each earlier segment in its
 * OWN T1..Tn space, fetched only when opened (a predecessor can be tens of
 * MB), each checkpoint rewindable via (sessionId, index) — the restore
 * executor cuts a truncated copy of THAT file and rebinds the agent to it.
 */

/** Two-tap REWIND arm expiry, matching the rail's own rewind affordance. */
const ARM_MS = 8000

export function LineagePanel({
  terminalId,
  allowActions,
  onClose
}: {
  terminalId: string
  /** Remote caller transcripts are readable but never mutate the owner's session. */
  allowActions: boolean
  onClose: () => void
}): React.JSX.Element {
  const [segments, setSegments] = useState<LineageSegmentRow[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** Segment whose rows are shown; the most recent earlier segment starts open. */
  const [openSid, setOpenSid] = useState<string | null>(null)
  const [armed, setArmed] = useState<{ sid: string; index: number } | null>(null)
  const [rewinding, setRewinding] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetchLineageSegments(terminalId)
      .then((list) => {
        if (!alive) return
        setSegments(list)
        // Newest earlier segment first is the one people came back for.
        setOpenSid(list[list.length - 1]?.sessionId ?? null)
      })
      .catch((error) => {
        if (alive) setFailed(error instanceof Error ? error.message : String(error))
      })
    return () => {
      alive = false
    }
  }, [terminalId])

  useEffect(() => {
    if (armed === null) return
    const timer = window.setTimeout(() => setArmed(null), ARM_MS)
    return () => window.clearTimeout(timer)
  }, [armed])

  const rewind = (sid: string, index: number): void => {
    if (rewinding) return
    if (armed === null || armed.sid !== sid || armed.index !== index) {
      setRefusal(null)
      setArmed({ sid, index })
      return
    }
    const restore = cookrew().restoreCheckpoint
    if (typeof restore !== 'function') return
    setRewinding(true)
    void restore(terminalId, index, sid)
      .then((result) => {
        if (result.ok) {
          onClose() // the node rebinds; the rail refreshes onto the restored segment
        } else {
          setRefusal(result.reason ?? 'Rewind refused.')
        }
      })
      .catch((error: unknown) => {
        setRefusal(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setArmed(null)
        setRewinding(false)
      })
  }

  // Newest earlier segment on top — it is the one the compact just hid.
  const shown = segments === null ? null : [...segments].reverse()
  const total = segments?.reduce((sum, s) => sum + s.count, 0) ?? 0

  return (
    <div
      className="cr-lineage-panel"
      role="dialog"
      aria-label="Earlier sessions"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="cr-lineage-head">
        <span className="cr-lineage-title">
          EARLIER SESSIONS
          {segments !== null && segments.length > 0 && (
            <span className="cr-lineage-total">
              {total} checkpoint{total === 1 ? '' : 's'} before this file
            </span>
          )}
        </span>
        <button className="cr-lineage-close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {refusal !== null && (
        <div className="cr-lineage-refusal" role="alert">
          {refusal}
        </div>
      )}
      {failed !== null ? (
        <div className="cr-lineage-empty">Could not read the lineage: {failed}</div>
      ) : shown === null ? (
        <div className="cr-lineage-empty">reading earlier transcripts…</div>
      ) : shown.length === 0 ? (
        // The chain walk only trusts DECLARED predecessor edges — an empty
        // answer is honest, never a guess at which sibling file came before.
        <div className="cr-lineage-empty">
          No earlier segment is provably linked to this session.
        </div>
      ) : (
        shown.map((segment) => (
          <div key={segment.sessionId} className="cr-lineage-segment">
            <button
              className={`cr-lineage-seghead${openSid === segment.sessionId ? ' open' : ''}`}
              onClick={() =>
                setOpenSid(openSid === segment.sessionId ? null : segment.sessionId)
              }
            >
              <span className="cr-lineage-sig">⇥ {segment.sessionId.slice(0, 8)}</span>
              <span className="cr-lineage-count">{segment.count} cp</span>
            </button>
            {openSid === segment.sessionId && (
              <div className="cr-lineage-rows" role="list">
                {segment.entries.map((entry) => (
                  <div
                    key={`${segment.sessionId}-${entry.index}`}
                    className="cr-lineage-row"
                    role="listitem"
                  >
                    <span className="cr-ckpt-row-idx">T{entry.index}</span>
                    <span className="cr-lineage-row-title">
                      {traceRowLabel(entry.index, entry.title)}
                    </span>
                    {allowActions && typeof cookrew().restoreCheckpoint === 'function' && (
                      <button
                        className={`cr-ckpt-action rewind${
                          armed?.sid === segment.sessionId && armed.index === entry.index
                            ? ' armed'
                            : ''
                        }`}
                        disabled={rewinding}
                        onClick={() => rewind(segment.sessionId, entry.index)}
                      >
                        {rewinding &&
                        armed?.sid === segment.sessionId &&
                        armed.index === entry.index
                          ? '…'
                          : armed?.sid === segment.sessionId && armed.index === entry.index
                            ? 'SURE?'
                            : '⟲'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}
      <div className="cr-lineage-foot">
        <CrIcon name="fork" /> rewinding copies the old transcript — nothing is deleted
      </div>
    </div>
  )
}
