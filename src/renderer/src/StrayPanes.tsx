import { useCallback, useEffect, useState } from 'react'
import { cookrew } from './api'
import type { StrayPane } from '../../shared/stray-pane'

/**
 * RUNNING WITHOUT A CARD. A pane that lost its card is still a process, and
 * with an agent in it a Claude with bypassed permissions, so the board says so.
 * Only a pane this app can prove it started gets END; the rest are shown with
 * no button that could hit someone else's process (orphan-reap.ts).
 */

export function strayEndHint(stray: StrayPane): string {
  return stray.proved ? '' : 'Nothing proves this app started it, so it is left running.'
}

export function StrayRows({
  strays,
  onEnd,
  onRecover,
  busy
}: {
  strays: readonly StrayPane[]
  onEnd: (stray: StrayPane) => void
  onRecover: (stray: StrayPane) => void
  /** The session being ended now. */
  busy: string | null
}): JSX.Element | null {
  if (strays.length === 0) return null
  return (
    <section className="stray-panes" aria-label="Running without a card">
      <div className="stray-title">Running without a card</div>
      {strays.map((stray) => (
        <div className="stray-row" key={stray.session}>
          <div className="stray-who">
            <span className="stray-name">{stray.name ?? stray.session}</span>
            <span className="stray-where">
              {stray.proved ? [stray.workspaceName, stray.cwd].filter(Boolean).join(' · ') : strayEndHint(stray)}
            </span>
          </div>
          {stray.proved && (
            <>
              <button type="button" className="cr-btn sm" onClick={() => onRecover(stray)}>
                RECOVER
              </button>
              <button type="button" className="cr-btn sm" disabled={busy === stray.session} onClick={() => onEnd(stray)}>
                END
              </button>
            </>
          )}
        </div>
      ))}
    </section>
  )
}

/** The board's stray list: read on open, and again after anything is ended or recovered. */
export function StrayPanes({ onSay }: { onSay: (text: string) => void }): JSX.Element | null {
  const [strays, setStrays] = useState<readonly StrayPane[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = useCallback(() => {
    void cookrew().listStrayPanes?.().then(setStrays).catch(() => undefined)
  }, [])
  useEffect(refresh, [refresh])

  const end = (stray: StrayPane): void => {
    setBusy(stray.session)
    void cookrew()
      .endStrayPane?.(stray.session)
      .then((outcome) => {
        if (!outcome.ok) onSay(outcome.error ?? `${stray.name ?? stray.session} did not stop`)
      })
      .catch((error: unknown) => onSay(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        setBusy(null)
        refresh()
      })
  }
  const recover = (stray: StrayPane): void => {
    if (stray.terminalId === null) return
    void cookrew()
      .recoverAgent?.(stray.terminalId)
      .then((result) => {
        if (!result.ok) onSay(`Could not recover ${stray.name ?? stray.session}`)
      })
      .catch((error: unknown) => onSay(error instanceof Error ? error.message : String(error)))
      .finally(refresh)
  }
  return <StrayRows strays={strays} onEnd={end} onRecover={recover} busy={busy} />
}
