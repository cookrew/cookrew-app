import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cookrew } from './api'
import { EnrolSheet, type EnrolSubmission } from './EnrolSheet'
import {
  GRANT_COPY,
  REVOKE_COPY,
  UNDO_WINDOW_MS,
  DUPLICATE_COPY,
  fill
} from './grant-copy'
import {
  changeOf,
  commitLabel,
  discard,
  emptyStateFor,
  isStaged,
  stageFrom,
  toggleAgent,
  type StagedGrants
} from './grant-stage'
import type { GrantRoster, RosterCaller } from '../../main/grant-roster'
import type { WorkspaceState } from '../../shared/model'
import './grant-surface.css'

/**
 * WHO CAN CALL (Velvet's deck) — the owner's granting surface.
 *
 * THE RULE THIS SCREEN IS BUILT FROM. A grant that is easy to give by accident
 * is a security defect, not a convenience. This surface is strictly more
 * powerful than the gate it feeds — whoever drives it can enrol themselves and
 * export everything, which makes every downstream refusal decorative. So
 * friction is placed deliberately and ASYMMETRICALLY: granting is slow and
 * specific, revoking is instant and cheap. Every choice below falls out of that
 * one sentence.
 *
 *   GRANTING   deliberate: paste → compare fingerprint → tick → commit
 *   REVOKING   one click, no confirm, 10-second undo
 *   BULK       no "select all", EVER. Revoke-all is offered.
 *
 * A confirm on revoke would be actively harmful: it is the control someone
 * reaches for when they have just realised something is wrong. The one confirm
 * in the whole surface is un-export, because it is the only action that removes
 * access from several people at once as a side effect of a switch that looks
 * like a preference.
 *
 * DESKTOP OWNER ONLY. The IPC refuses any sender that is not the owner window's
 * top frame, so this must not render on a phone companion or a read-only wall —
 * NOT EVEN DISABLED. A greyed-out list of who is enrolled still discloses who
 * is enrolled, on the device most likely to be lying on a table. The entry
 * point is absent, not inert; see `canGrant`.
 */

/** Is the grant surface reachable at all? Absence, not a disabled state. */
export function canGrant(
  api: Record<string, unknown> = cookrew() as unknown as Record<string, unknown>
): boolean {
  // The preload bridge exposes these only in the owner's window. Outside
  // Electron the remote/demo apis do not carry them, so a phone companion and
  // a browser card both answer false and the entry point never renders.
  return typeof api.grantList === 'function' && typeof api.grantEnrol === 'function'
}

type Toast =
  | { kind: 'undo'; sub: string; name: string; stopped: number; until: number }
  | { kind: 'error'; text: string; id: string; retry: () => void }

const agentName = (workspace: WorkspaceState | null, nodeId: string): string => {
  const node = workspace?.nodes?.find((n) => n.id === nodeId)
  return (node as { name?: string } | undefined)?.name ?? nodeId
}

function ago(at: number | undefined, now: number): string {
  if (at === undefined) return 'never'
  const mins = Math.floor((now - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

export function GrantPanel({
  workspace,
  workspaceId,
  onClose
}: {
  workspace: WorkspaceState | null
  workspaceId: string
  onClose: () => void
}): React.JSX.Element | null {
  const [roster, setRoster] = useState<GrantRoster | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [staged, setStaged] = useState<StagedGrants | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [enrolError, setEnrolError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [unexporting, setUnexporting] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async (): Promise<GrantRoster | null> => {
    const api = cookrew() as unknown as { grantList?: (id: string) => Promise<GrantRoster> }
    if (!api.grantList) return null
    const next = await api.grantList(workspaceId)
    setRoster(next)
    return next
  }, [workspaceId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The live-call count is what makes the revoke copy checkable, so it has to
  // keep up. A slow poll: this is a roster, not a stream.
  useEffect(() => {
    const tick = setInterval(() => {
      setNow(Date.now())
      void refresh()
    }, 3000)
    return () => clearInterval(tick)
  }, [refresh])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  if (!canGrant()) return null

  const callers = roster?.callers ?? []
  const agents = roster?.agents ?? []
  const revoked = roster?.revoked ?? []
  const exportable = agents.map((a) => a.nodeId)

  const openCaller = (caller: RosterCaller): void => {
    setOpen(caller.sub)
    setStaged(stageFrom(caller.agents))
  }

  const closeCaller = (): void => {
    // Leaving with un-committed ticks warns once and discards (deck §5, 5).
    if (staged && !changeOf(staged).clean) {
      // eslint-disable-next-line no-alert
      const go = window.confirm('Discard the ticks you have not committed? A staged grant is not a grant.')
      if (!go) return
    }
    setOpen(null)
    setStaged(null)
  }

  const commit = async (caller: RosterCaller): Promise<void> => {
    if (!staged) return
    const change = changeOf(staged)
    if (change.clean) return
    setBusy(true)
    try {
      const api = cookrew() as unknown as {
        grantExport: (w: string, n: string, c: string[]) => Promise<{ ok: boolean }>
      }
      // One export per agent, because a grant IS (caller × agent) and the
      // record is keyed by agent. Ticks are applied against the agent's
      // existing caller list rather than replacing it — another caller's grant
      // is not this owner's change to make.
      for (const nodeId of [...change.added, ...change.removed]) {
        const current = agents.find((a) => a.nodeId === nodeId)?.callers ?? []
        const next = staged.staged.has(nodeId)
          ? [...new Set([...current, caller.sub])]
          : current.filter((c) => c !== caller.sub)
        const result = await api.grantExport(workspaceId, nodeId, next)
        if (!result?.ok) throw new Error('grant refused')
      }
      await refresh()
      setOpen(null)
      setStaged(null)
    } catch {
      // THE DIRECTION SPLIT. "Access is unchanged" is reassurance when the
      // change ADDED access and a lie with consequences when it REMOVED it.
      const copy =
        change.direction === 'remove' ? GRANT_COPY.errorCommitRemove : GRANT_COPY.errorCommitAdd
      setToast({
        kind: 'error',
        id: copy.id,
        text: fill(copy.text, { name: caller.name ?? caller.sub }),
        retry: () => void commit(caller)
      })
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (caller: RosterCaller): Promise<void> => {
    // INSTANT, NO CONFIRM. Undo rather than confirm: it costs nothing when you
    // meant it and recovers fully when you did not.
    const api = cookrew() as unknown as {
      grantRevoke: (w: string, s: string) => Promise<{ ok: boolean; stopped?: number }>
    }
    try {
      const result = await api.grantRevoke(workspaceId, caller.sub)
      if (!result?.ok) throw new Error('revoke refused')
      await refresh()
      setToast({
        kind: 'undo',
        sub: caller.sub,
        name: caller.name ?? caller.sub,
        stopped: result.stopped ?? 0,
        until: Date.now() + UNDO_WINDOW_MS
      })
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setToast(null), UNDO_WINDOW_MS)
    } catch {
      setToast({
        kind: 'error',
        id: GRANT_COPY.errorRevoke.id,
        text: fill(GRANT_COPY.errorRevoke.text, { name: caller.name ?? caller.sub }),
        retry: () => void revoke(caller)
      })
    }
  }

  const undo = async (sub: string): Promise<void> => {
    const api = cookrew() as unknown as {
      grantRestore: (w: string, s: string) => Promise<{ ok: boolean }>
    }
    await api.grantRestore(workspaceId, sub)
    await refresh()
    setToast(null)
  }

  const enrol = async (submission: EnrolSubmission): Promise<void> => {
    setBusy(true)
    setEnrolError(null)
    try {
      const api = cookrew() as unknown as {
        grantEnrol: (w: string, s: string, j: unknown) => Promise<{ ok: boolean; reason?: string }>
      }
      const result = await api.grantEnrol(workspaceId, submission.sub, submission.jwk)
      if (!result?.ok) {
        setEnrolError(
          result?.reason === 'caller_exists'
            ? fill(DUPLICATE_COPY.text, { name: submission.sub })
            : fill(GRANT_COPY.errorEnrol.text, { name: submission.sub })
        )
        return
      }
      await refresh()
      setEnrolling(false)
    } catch {
      setEnrolError(fill(GRANT_COPY.errorEnrol.text, { name: submission.sub }))
    } finally {
      setBusy(false)
    }
  }

  const unexport = async (nodeId: string): Promise<void> => {
    const api = cookrew() as unknown as {
      grantUnexport: (w: string, n: string) => Promise<{ ok: boolean; stopped?: number }>
    }
    await api.grantUnexport(workspaceId, nodeId)
    await refresh()
    setUnexporting(null)
  }

  const openRow = callers.find((c) => c.sub === open) ?? null
  const label = openRow && staged ? commitLabel(openRow.name ?? openRow.sub, staged, (id) => agentName(workspace, id)) : null

  return (
    <div className="gs-panel">
      <header className="gs-head">
        <div>
          <h1>Who can call</h1>
          <p className="gs-sub">
            {workspace?.name ?? workspaceId} · granting is deliberate, revoking is instant
          </p>
        </div>
        <div className="gs-head-actions">
          <button className="gs-enrol" onClick={() => { setEnrolError(null); setEnrolling(true) }}>
            ＋ ENROL A CALLER
          </button>
          <button className="gs-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
      </header>

      {emptyStateFor({ agents, callers }) === 'no-export' && (
        <section className="gs-empty" data-copy-id={GRANT_COPY.emptyNoExport.id}>
          <h2>{GRANT_COPY.emptyNoExport.title}</h2>
          <p>{GRANT_COPY.emptyNoExport.body}</p>
        </section>
      )}

      {emptyStateFor({ agents, callers }) === 'no-callers' && (
        <section className="gs-empty" data-copy-id={GRANT_COPY.emptyNoCallers.id}>
          <h2>{GRANT_COPY.emptyNoCallers.title}</h2>
          <p>{GRANT_COPY.emptyNoCallers.body}</p>
          <button className="gs-enrol" onClick={() => setEnrolling(true)}>
            {GRANT_COPY.emptyNoCallers.action}
          </button>
        </section>
      )}

      {callers.length > 0 && (
        <table className="gs-table">
          <thead>
            <tr>
              <th>Caller</th>
              <th>Fingerprint</th>
              <th>May call</th>
              <th>Last call</th>
              <th>Seats · expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {callers.map((caller) => {
              const isOpen = caller.sub === open
              return (
                <>
                  <tr key={caller.sub} className={isOpen ? 'gs-row gs-open' : 'gs-row'}>
                    <td>
                      <button
                        className="gs-caller"
                        onClick={() => (isOpen ? closeCaller() : openCaller(caller))}
                      >
                        {caller.name ?? caller.sub}
                      </button>
                      {caller.name && <span className="gs-dim">{caller.sub}</span>}
                    </td>
                    <td className="gs-mono gs-dim">
                      {caller.fingerprint ? `${caller.fingerprint.words.slice(0, 3).join(' ')}…` : '—'}
                    </td>
                    <td>
                      {caller.agents.length === 0 ? (
                        <span className="gs-dim" data-copy-id={GRANT_COPY.emptyNoGrants.id}>
                          nothing yet
                        </span>
                      ) : (
                        caller.agents.map((id) => agentName(workspace, id)).join(' · ')
                      )}
                    </td>
                    <td className="gs-dim">{ago(caller.lastCallAt, now)}</td>
                    <td className="gs-dim">— M3 —</td>
                    <td>
                      <button className="gs-revoke" onClick={() => void revoke(caller)}>
                        REVOKE
                      </button>
                    </td>
                  </tr>
                  {isOpen && staged && (
                    <tr key={`${caller.sub}-grants`} className="gs-drawer">
                      <td colSpan={6}>
                        {/*
                          EXPORTABLE AGENTS ONLY. A non-exportable agent is not
                          listed at all — a disabled row invites a fight with
                          the wrong control.
                          NO SELECT-ALL. One deliberate tick per agent, and its
                          absence is the feature.
                        */}
                        {exportable.length === 0 ? (
                          <p className="gs-dim">{GRANT_COPY.emptyNoExport.body}</p>
                        ) : (
                          <ul className="gs-ticks">
                            {exportable.map((nodeId) => (
                              <li key={nodeId}>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={isStaged(staged, nodeId)}
                                    onChange={() => setStaged(toggleAgent(staged, nodeId))}
                                  />
                                  <span>{agentName(workspace, nodeId)}</span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        )}
                        {label && (
                          <div className="gs-commit">
                            <button
                              className="gs-primary"
                              disabled={busy}
                              onClick={() => void commit(caller)}
                            >
                              {label.button}
                            </button>
                            <p className="gs-consequence">{label.consequence}</p>
                          </div>
                        )}
                        {!label && <p className="gs-dim">Tick an agent to grant it.</p>}
                        {staged && !changeOf(staged).clean && (
                          <button className="gs-ghost" onClick={() => setStaged(discard(staged))}>
                            Discard ticks
                          </button>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      )}

      {agents.length > 0 && (
        <section className="gs-agents">
          <h2>Exported agents</h2>
          <ul>
            {agents.map((a) => (
              <li key={a.nodeId}>
                <span>{agentName(workspace, a.nodeId)}</span>
                <span className="gs-dim">
                  {a.callers.length} caller{a.callers.length === 1 ? '' : 's'}
                  {a.inFlight > 0 && (
                    <strong className="gs-live"> · {a.inFlight} calling now</strong>
                  )}
                </span>
                <button className="gs-revoke" onClick={() => setUnexporting(a.nodeId)}>
                  STOP EXPORTING
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* REVOKED — revoking does not delete history (deck §6). */}
      {revoked.length > 0 && (
        <section className="gs-revoked">
          <h2>Revoked</h2>
          <ul>
            {revoked.map((r) => (
              <li key={r.sub}>
                <span>{r.name ?? r.sub}</span>
                <span className="gs-dim">last call {ago(r.lastCallAt, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The ONE confirm in this surface. See the header note. */}
      {unexporting && (
        <div className="gs-scrim" role="dialog" aria-modal="true">
          <div className="gs-sheet gs-small" data-copy-id={GRANT_COPY.confirmUnexport.id}>
            <h2>{fill(GRANT_COPY.confirmUnexport.title, { agent: agentName(workspace, unexporting) })}</h2>
            <p>
              {fill(GRANT_COPY.confirmUnexport.body, {
                n: agents.find((a) => a.nodeId === unexporting)?.callers.length ?? 0
              })}
            </p>
            <footer className="gs-sheet-foot">
              <button className="gs-ghost" onClick={() => setUnexporting(null)}>Cancel</button>
              <button className="gs-primary" onClick={() => void unexport(unexporting)}>
                {GRANT_COPY.confirmUnexport.action}
              </button>
            </footer>
          </div>
        </div>
      )}

      {enrolling && (
        <EnrolSheet
          onEnrol={(s) => void enrol(s)}
          onClose={() => setEnrolling(false)}
          existing={callers}
          busy={busy}
          error={enrolError}
        />
      )}

      {toast?.kind === 'undo' && (
        <div className="gs-toast" role="status">
          <span>
            {fill(REVOKE_COPY.line, { name: toast.name })} {REVOKE_COPY.stopped(toast.stopped)}
          </span>
          <button className="gs-undo" onClick={() => void undo(toast.sub)}>
            {REVOKE_COPY.undo}
          </button>
        </div>
      )}
      {toast?.kind === 'error' && (
        <div className="gs-toast gs-toast-bad" role="alert" data-copy-id={toast.id}>
          <span>{toast.text}</span>
          <button className="gs-undo" onClick={toast.retry}>RETRY</button>
        </div>
      )}
    </div>
  )
}
