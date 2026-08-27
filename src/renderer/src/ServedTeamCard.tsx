import { useCallback, useEffect, useState } from 'react'
import { cookrew } from './api'
import {
  MKT_SERVE,
  MKT_SESSIONS,
  fillCopy,
  servedPaymentRailsLabel
} from '../../shared/marketplace-copy'
import type { ServedPaymentRail } from '../../shared/served-payment-rails'
import { readyPaymentRails, type ServedPaymentStatus } from '../../shared/served-payment-config'
// The gs-* sheet primitives — stated by the wearer, not inherited from the
// (retired) GrantPanel that used to carry this import.
import './grant-surface.css'

/**
 * A SERVED TEAM's card — the address, who is on, and the way to stop.
 *
 * This is where WHO CAN CALL went (owner ruling, 2026-08-26). "Who is on my
 * crew?" is a question about a thing you published, so it is answered ON that
 * thing rather than in a global admin panel — which is exactly what let the old
 * entry be retired instead of merely moved.
 *
 * END destroys someone else's workspace, so it confirms with the CONSEQUENCE
 * rather than asking "are you sure": the sentence says what stops and what
 * survives, and the button repeats the verb.
 */

interface Session {
  sessionId: string
  serviceId: string
  caller: string
  workspaceName: string
  version: number
}

export interface ServedTeam {
  serviceId: string
  templateId: string
  slug: string
  access: 'account' | 'paid'
  priceUsd?: string
  address: string
  paymentRails: readonly ServedPaymentRail[]
}

export function ServedTeamCard({
  team,
  door,
  paymentStatus,
  onConfigurePayments,
  onStopped,
  onClose
}: {
  team: ServedTeam
  /**
   * The orch's name — the one door a caller reaches — or null when the canvas
   * this card was opened over flags no orch. A served crew always HAS an orch
   * (serve refuses otherwise), but this name is derived from the open
   * workspace rather than the served template, so the two can differ and the
   * honest answer to "which one?" is sometimes "not from here".
   */
  door: string | null
  paymentStatus: ServedPaymentStatus
  onConfigurePayments: () => void
  onStopped: () => void
  onClose: () => void
}): React.JSX.Element {
  const [sessions, setSessions] = useState<readonly Session[]>([])
  const [confirmEnd, setConfirmEnd] = useState<Session | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(() => {
    void cookrew()
      .servingSessions()
      .then((all) => setSessions(all.filter((s) => s.serviceId === team.serviceId)))
      .catch(() => undefined)
  }, [team.serviceId])
  useEffect(refresh, [refresh])

  const paymentRails = Array.from(
    new Set([...team.paymentRails, ...readyPaymentRails(paymentStatus)])
  )
  const priceLine =
    team.access === 'paid'
      ? fillCopy(MKT_SERVE['mkt.serve.price.paid'], {
          price: team.priceUsd ?? '',
          rails:
            paymentRails.length > 0
              ? servedPaymentRailsLabel(paymentRails)
              : MKT_SERVE['mkt.serve.rails.none.short']
        })
      : MKT_SERVE['mkt.serve.price.free']

  return (
    <div className="gs-scrim" role="dialog" aria-modal="true" aria-label={`${team.templateId} — serving`}>
      <div
        className="gs-sheet"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>
            {fillCopy(
              team.access === 'paid' && paymentRails.length === 0
                ? MKT_SERVE['mkt.serve.payment.live-blocked']
                : MKT_SERVE['mkt.serve.live'],
              { templateName: team.templateId }
            )}
          </h2>
          <button className="gs-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {/* The payoff: a thing you can hand to someone. */}
        <section className="stc-addr">
          <code className="stc-addr-url">{team.address}</code>
          <button
            className="cr-btn sm"
            onClick={() => {
              void navigator.clipboard?.writeText(team.address)
              setCopied(true)
            }}
          >
            {copied ? 'COPIED ✓' : 'COPY LINK'}
          </button>
        </section>
        <p className="gs-sub">
          {door === null
            ? priceLine
            : fillCopy(MKT_SERVE['mkt.serve.live.address'], { orch: door, priceLine })}
        </p>
        {team.access === 'paid' && paymentRails.length === 0 && (
          <section className="stc-payment-gap" role="alert">
            <p>{MKT_SERVE['mkt.serve.payment.required']}</p>
            <button className="gs-primary" onClick={onConfigurePayments}>
              {MKT_SERVE['mkt.serve.payment.setup']}
            </button>
          </section>
        )}

        <section className="stc-sessions">
          <span className="gs-label">{MKT_SESSIONS['mkt.sessions.col.caller'].toUpperCase()}</span>
          {sessions.length === 0 ? (
            <p className="gs-foot-note">{MKT_SESSIONS['mkt.sessions.empty']}</p>
          ) : (
            sessions.map((s) => (
              <div key={s.sessionId} className="stc-row">
                <span className="stc-caller">{s.workspaceName}</span>
                <span className="stc-ver">V{s.version}</span>
                <span className="stc-state">{MKT_SESSIONS['mkt.sessions.state.working']}</span>
                <button className="cr-btn sm" onClick={() => setConfirmEnd(s)}>
                  {MKT_SESSIONS['mkt.sessions.end.action']}
                </button>
              </div>
            ))
          )}
        </section>

        {/* The consequence, not "are you sure". */}
        {confirmEnd && (
          <section className="stc-confirm" role="alertdialog" aria-label="End this workspace?">
            <p className="stc-confirm-t">
              {fillCopy(MKT_SESSIONS['mkt.sessions.end.confirm.title'], {
                caller: confirmEnd.workspaceName
              })}
            </p>
            <p className="stc-confirm-b">{MKT_SESSIONS['mkt.sessions.end.confirm.body']}</p>
            <div className="stc-confirm-acts">
              <button className="gs-ghost" onClick={() => setConfirmEnd(null)}>
                Cancel
              </button>
              <button
                className="gs-primary stc-danger"
                onClick={() => {
                  const target = confirmEnd
                  setConfirmEnd(null)
                  void cookrew()
                    .servingEnd(target.sessionId)
                    .then(refresh)
                    .catch(() => undefined)
                }}
              >
                {MKT_SESSIONS['mkt.sessions.end.confirm.action']}
              </button>
            </div>
          </section>
        )}

        <p className="gs-foot-note">{MKT_SERVE['mkt.serve.safety']}</p>

        <footer className="gs-sheet-foot">
          <button
            className="gs-ghost stc-danger-text"
            onClick={() => {
              void cookrew()
                .servingStop(team.serviceId)
                .then(() => onStopped())
                .catch(() => undefined)
            }}
          >
            {MKT_SERVE['mkt.serve.stop.action']}
          </button>
          <button className="gs-primary" onClick={onClose}>
            DONE
          </button>
        </footer>
      </div>
    </div>
  )
}
