import { useCallback, useEffect, useState } from 'react'
import type { AccountStatus } from '../../../shared/account-v2'
import {
  REQUEST_COPY,
  badMatchNote,
  isMatchComplete,
  queueEmpty,
  queueFooter,
  queueView,
  type AnsweredRow,
  type QueueRow,
  type RequestRowView,
  type RowAction,
} from '../../../shared/account-requests'
import { cookrew } from '../api'
import { refusalSentence } from './account-store'
import { DOING, problemSentence } from './problem'
import '../grant-surface.css'

/**
 * THE ONE QUEUE (D11) — three kinds of row, one card.
 *
 * It replaces D6's arrangement, where a sign-in was a card pinned above every
 * tab and the other two kinds had nowhere to be at all. One tab, one badge,
 * one habit: the avatar's badge, the system notification and this list all
 * land in the same place, so a person who saw the toast and a person who saw
 * the badge end up looking at the same row.
 *
 * THIS COMPONENT DECIDES NOTHING. Which sentence a row reads, which buttons it
 * offers, whether APPROVE may fire, what a finished row's chip says — all of
 * it is `queueView` in shared/account-requests.ts, where it is tested without
 * a window. What is here is the painting and the three effects a list needs.
 *
 * THE NUMBER IS THE WHOLE POINT OF THE JOIN ROW (R3). APPROVE is dead until
 * the two digits are typed, because the rung exists to make SEEING the other
 * machine's screen a hard condition — a person can be nagged into tapping a
 * button, and a button that can be tapped without reading anything is worth
 * nothing. DENY and NOT ME stay one press: an alarm that is harder to raise
 * than a mistake is an alarm people stop raising.
 */

/** The "4 minutes ago" clause is re-read once a second, like D6's was. */
const TICK_MS = 1_000

type Note = { id: string; text: string }

function Row({
  view,
  match,
  busy,
  note,
  onMatch,
  onAct,
}: {
  view: RequestRowView
  match: string
  busy: boolean
  note: string | null
  onMatch: (value: string) => void
  onAct: (action: RowAction['id']) => void
}): React.JSX.Element {
  const ready = isMatchComplete(match)
  return (
    <li className="cr-acct-device cr-acct-request-row" data-kind={view.kind}>
      <span className="cr-acct-avatar cr-acct-claimed" aria-hidden="true">
        <span className="cr-acct-initials">{view.initials}</span>
      </span>
      <span className="cr-acct-seclabel">
        {view.lead}
        <br />
        <span className="gs-sub cr-acct-askdetail">{view.detail}</span>
      </span>
      {view.chip !== null && <span className="cr-acct-secstate cr-acct-over">{view.chip}</span>}
      {view.matchLabel !== null && (
        <input
          className="gs-input cr-acct-match"
          aria-label={view.matchLabel}
          placeholder={view.matchLabel}
          inputMode="numeric"
          maxLength={2}
          autoComplete="off"
          value={match}
          disabled={busy}
          onChange={(e) => onMatch(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready && !busy) onAct('approve')
          }}
        />
      )}
      {view.actions.map((action) => (
        <button
          key={action.id}
          className={action.tone === 'primary' ? 'gs-primary' : action.tone === 'revoke' ? 'gs-revoke' : 'gs-ghost'}
          // A row whose number is not filled in has a DEAD primary, not a
          // hidden one: the button is where the person is looking, and the
          // field beside it is the reason it will not move.
          disabled={busy || (action.needsMatch === true && !ready)}
          onClick={() => onAct(action.id)}
        >
          {action.label}
        </button>
      ))}
      {note !== null && (
        <p className="gs-paste-error cr-acct-rownote" role="alert">
          {note}
        </p>
      )}
    </li>
  )
}

export function RequestsTab({
  username,
  refreshKey,
  focusId = null,
  onStatus,
  initial = null,
  now,
}: {
  username: string
  /** Bumped by the badge count, so answering here and the bar cannot disagree. */
  refreshKey: number
  /** The row a notification was clicked for; it is shown first. */
  focusId?: string | null
  onStatus: (next: AccountStatus) => void
  /** Pinned by a static render, which has no effects to fetch with. */
  initial?: { pending: readonly QueueRow[]; answered: readonly AnsweredRow[] } | null
  /** Fixed by a test; otherwise the wall clock, ticking. */
  now?: number
}): React.JSX.Element {
  const [queue, setQueue] = useState(initial ?? { pending: [], answered: [] })
  const [matches, setMatches] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [tick, setTick] = useState(now ?? Date.now())

  const reload = useCallback((): void => {
    const call = cookrew().accountRequests
    if (!call) return
    void call()
      .then(setQueue)
      .catch(() => undefined)
  }, [])

  useEffect(reload, [reload, refreshKey])

  useEffect(() => {
    if (now !== undefined) return
    const timer = window.setInterval(() => setTick(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [now])

  const act = (id: string, action: RowAction['id']): void => {
    const call = cookrew().accountDecideRequest
    if (!call || busy !== null) return
    setBusy(id)
    setNote(null)
    void call({ id, action, ...(matches[id] ? { match: matches[id] } : {}) })
      .then((result) => {
        setBusy(null)
        if (result.ok) {
          onStatus(result.value)
          // The number is spent either way: a fresh one is shown on the
          // asking device the next time it asks.
          setMatches((prior) => ({ ...prior, [id]: '' }))
          reload()
          return
        }
        if (result.reason === 'bad_match') {
          const left = result.triesLeft ?? 0
          setMatches((prior) => ({ ...prior, [id]: '' }))
          setNote({ id, text: badMatchNote(left, result.message) })
          // The third miss ends the sign-in at the registry, so the row is
          // about to be gone — re-read rather than leave it on screen.
          if (left <= 0) reload()
          return
        }
        setNote({ id, text: refusalSentence(result.reason as never, result.message, username) })
      })
      .catch((err: unknown) => {
        setBusy(null)
        setNote({ id, text: problemSentence(DOING.DECIDE, err) })
      })
  }

  const rows = queueView(queue.pending, queue.answered, { username, now: now ?? tick })
  const ordered =
    focusId === null ? rows : [...rows].sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1 : 0))

  return (
    <section className="cr-acct-pane" aria-label="Requests">
      {ordered.length === 0 ? (
        <p className="gs-sub">{queueEmpty()}</p>
      ) : (
        <ul className="cr-acct-devices">
          {ordered.map((view) => (
            <Row
              key={view.id}
              view={view}
              match={matches[view.id] ?? ''}
              busy={busy === view.id}
              note={note?.id === view.id ? note.text : null}
              onMatch={(value) => setMatches((prior) => ({ ...prior, [view.id]: value }))}
              onAct={(action) => act(view.id, action)}
            />
          ))}
        </ul>
      )}
      {/* WHAT EACH BUTTON ACTUALLY DOES, under the list rather than in a
          tooltip: ALLOW hands over a keyboard and NOT ME signs every other
          device out, and neither is a thing to learn by pressing it. */}
      <p className="gs-foot-note">{queueFooter()}</p>
    </section>
  )
}

export { REQUEST_COPY }
