import { useState } from 'react'
import { EXPORT_COPY, GRANT_COPY, fill } from './grant-copy'
import type { AgentExportState } from './grant-state'

/**
 * THE FIRST INCH OF THE AUTHOR JOURNEY.
 *
 * Magpie's journey audit ranked "the author journey does not exist" above even
 * the 1.4-second lag as the reason to give up: zero of forty clickable controls
 * mentioned publish, export, sell, price or payout, and publishing one priced
 * preset took ~140 lines of hand-written crypto. This control is where that
 * story starts, so it is built as an ENTRY POINT and not as a settings
 * checkbox — a checkbox tells you a state, an entry point tells you there is
 * something here and what happens next.
 *
 * VELVET'S SENTENCE 6, VERBATIM AND AT THE MOMENT OF DECIDING. Her audit found
 * that exporting is safe by construction — a call forks the transcript, the
 * original session is never mutated — and that version-pin.ts opens with
 * exactly that sentence while no author has ever been told. It is the
 * number-one reason not to export, it is already true, and it costs nothing to
 * say. So it sits beside the control rather than behind it: a guarantee an
 * author has to already trust us enough to go looking for is not a guarantee
 * that does any work.
 *
 * THE SEAM IS STATED, NOT MOCKED UP. Price, payout and pushing to a registry
 * belong to a lane nobody has been assigned. The honest repair for "no control
 * mentions selling" is not a dead button that opens nothing — an author who
 * presses that learns we are unreliable, which is worse than the gap. So the
 * surface says plainly what is not built.
 */

export function ExportToggle({
  agentName,
  state,
  onExport,
  onUnexport,
  onOpenGrants,
  busy = false,
  error = null
}: {
  agentName: string
  /** null when the roster could not be read — render nothing, never a default. */
  state: AgentExportState | null
  onExport: () => void
  onUnexport: () => void
  onOpenGrants: () => void
  /** In flight: the control disables so one press cannot become two. */
  busy?: boolean
  /**
   * A failure to report, already worded for the DIRECTION it failed in.
   *
   * Rendered beside the control the author pressed rather than in a global
   * toast: this is a per-row action, and an error that appears somewhere else
   * makes the author look for which row it belonged to.
   */
  error?: string | null
}): React.JSX.Element | null {
  const [confirming, setConfirming] = useState(false)

  if (state === null) return null

  const stop = (e: React.MouseEvent): void => e.stopPropagation()

  const turnOff = (): void => {
    // The one confirm in this surface, and only when it takes access away from
    // somebody. Un-exporting an agent nobody can call costs nothing and asks
    // nothing — a confirm there would train the owner to dismiss the one that
    // matters.
    if (state.callers > 0) setConfirming(true)
    else onUnexport()
  }

  return (
    <span className="ex-wrap" onClick={stop}>
      {/*
        ACCESS, LEGIBLE AT REST (Velvet §6). On the row, not in a panel: the
        question "who can call this right now" is asked in a glance, and an
        answer that costs a click is an answer nobody has.
      */}
      <span className={`ex-at-rest${state.exportable ? ' ex-on' : ''}`}>
        {EXPORT_COPY.atRest(state.callers, state.exportable)}
        {state.inFlight > 0 && (
          <strong className="ex-live"> · {state.inFlight} calling now</strong>
        )}
      </span>

      {!state.exportable ? (
        <button
          className="ex-invite"
          disabled={busy}
          onClick={onExport}
          title={EXPORT_COPY.safety}
        >
          {EXPORT_COPY.turnOn}
        </button>
      ) : (
        <>
          <button className="ex-next" onClick={onOpenGrants}>
            {EXPORT_COPY.next}
          </button>
          <button className="ex-off" disabled={busy} onClick={turnOff}>
            {EXPORT_COPY.turnOff}
          </button>
        </>
      )}

      {/*
        THE GUARANTEE, at the moment of deciding — while the agent is not yet
        exportable, which is exactly when the fear is live. Not kept on screen
        afterwards: a reassurance that never goes away stops being read, and by
        then the author's question has changed to who can call it.
      */}
      {!state.exportable && <span className="ex-safety">{EXPORT_COPY.safety}</span>}

      {error && (
        <span className="ex-error" role="alert">
          {error}
        </span>
      )}

      {state.exportable && (
        <span className="ex-hint">
          {EXPORT_COPY.onHint}
          <span className="ex-seam">{EXPORT_COPY.publishSeam}</span>
        </span>
      )}

      {confirming && (
        <span className="gs-scrim" onClick={stop}>
          <span className="gs-sheet gs-small" data-copy-id={GRANT_COPY.confirmUnexport.id}>
            <h2>{fill(GRANT_COPY.confirmUnexport.title, { agent: agentName })}</h2>
            <p>{fill(GRANT_COPY.confirmUnexport.body, { n: state.callers })}</p>
            <span className="gs-sheet-foot">
              <button className="gs-ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                className="gs-primary"
                onClick={() => {
                  setConfirming(false)
                  onUnexport()
                }}
              >
                {GRANT_COPY.confirmUnexport.action}
              </button>
            </span>
          </span>
        </span>
      )}
    </span>
  )
}
