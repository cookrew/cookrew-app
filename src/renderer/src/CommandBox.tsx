import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cookrew, isRemoteMode } from './api'
import { useCanvasUi } from './canvas-ui'
import { createHold, enterAction, enterSubmits, modeBadge, needsSendAnyway, holdMode, type CommitAck, type Hold } from './decision-hold'
import { appendAlternates, createInboxFeed, draftOnOpen, holdsInbox, inboxRowId, isDecisionUpdate, sousRowActions } from './command-box-feed'
import { waitedFor, type InboxRow } from '../../shared/inbox-rank'
import { INBOX_MARK } from '../../shared/inbox-copy'
import type { Decision, SousCommandResult } from '../../main/sous-control'
import type { Alternate } from '../../shared/sous-decide'
import './command-box.css'

/**
 * THE ONE BOX (route program R3 — design sections 4 and 5, mock
 * docs/ui-magpie/r3-command-inbox.html). It is two things in one place:
 *
 *   the command line to Sous: a sentence in, the DECISION out as the line
 *   under the box — who, the model, and the three reasons — held for a beat
 *   so the owner can change it, committed on Enter at once;
 *
 *   the HITL inbox: when something only a person can move is waiting, the
 *   rows sit ABOVE the box (card · reason · waited for · what it blocks), and
 *   one click lands in that card with the right input focused. A `sous` row
 *   is Sous's own: its proposal on one line, RETRY / OPEN / DISMISS.
 *
 * Desktop: ⌘K shows it, Esc hides it. Phone: it is the bottom bar and is
 * always there. Both read the same rows and talk to the same Sous.
 *
 * THE HOLD IS A MACHINE (decision-hold.ts), not an effect on the echo: closing
 * the box cancels it and tells main to drop the token; a keystroke or
 * "change" pauses it; Enter and the alternate commit it once. HP: the hold
 * ticks by default (2.5 s); main may send it paused, or as a question or an
 * answer with no hold; an exposure ≥ 2 decision commits only through its own
 * SEND ANYWAY button — Enter focuses it and never commits. A late revision
 * from main may only append alternates to the open list.
 *
 * DRAFT HYGIENE: closing the box clears the field and cancels a held
 * decision; a field found non-empty when the box opens is a draft from
 * earlier, said as a chip, never sent by surprise.
 */

const WAIT_TICK_MS = 60_000

export interface CommandBoxProps {
  open: boolean
  onClose: () => void
  phone?: boolean
  /** Test seam: the rows to draw instead of the bridge's. */
  rows?: InboxRow[]
  /** Test seam: a decision already on the line. */
  initialDecision?: Decision | null
  /** Test seam: something Sous already said — main's own sentence, shown as it is. */
  initialSaid?: string | null
  /** Test seam: text already in the field when the box opens (a draft from earlier). */
  initialText?: string
}

/** What Sous said stays this long, then fades; a decision never fades. */
export const SAID_FADE_MS = 3500

type Echo = { kind: 'decision'; decision: Decision; left: number } | { kind: 'said'; text: string; refused: boolean }

export function CommandBox({ open, onClose, phone, rows: givenRows, initialDecision = null, initialSaid = null, initialText = '' }: CommandBoxProps): React.JSX.Element | null {
  const { jumpToNode } = useCanvasUi()
  const [rows, setRows] = useState<InboxRow[]>(givenRows ?? [])
  const [text, setText] = useState(initialText)
  const [draft, setDraft] = useState(() => draftOnOpen(initialText))
  const [busy, setBusy] = useState(false)
  const [echo, setEcho] = useState<Echo | null>(
    initialDecision ? { kind: 'decision', decision: initialDecision, left: initialDecision.holdMs } : initialSaid ? { kind: 'said', text: initialSaid, refused: false } : null
  )
  const [alts, setAlts] = useState(false)
  const [, setClock] = useState(0)
  const field = useRef<HTMLInputElement>(null)
  const sendAnyway = useRef<HTMLButtonElement>(null)
  const hold = useRef<Hold | null>(null)
  const slotTimer = useRef<number | null>(null)
  const textRef = useRef(text)
  textRef.current = text
  const isPhone = phone ?? isRemoteMode()

  // The rows: the subscription HOLDS the list open in main (it is built only
  // while someone looks), so it is attached only while the box can be seen —
  // open, on either surface — and detached when it cannot.
  useEffect(() => {
    if (givenRows) return
    if (!holdsInbox({ open, phone: isPhone })) return
    const feed = createInboxFeed(cookrew(), (list) => setRows(list as InboxRow[]))
    feed.attach()
    return () => feed.detach()
  }, [givenRows, open, isPhone])

  // The printed wait comes from `since` and moves once a minute.
  useEffect(() => {
    if (rows.length === 0) return
    const timer = window.setInterval(() => setClock((c) => c + 1), WAIT_TICK_MS)
    return () => window.clearInterval(timer)
  }, [rows.length])

  useEffect(() => {
    if (open) field.current?.focus()
  }, [open])

  // Opening with something already in the field: a draft from earlier, said.
  useEffect(() => {
    if (open) setDraft(draftOnOpen(textRef.current))
  }, [open])

  const say = useCallback((result: SousCommandResult) => {
    if (result.spoken) setEcho({ kind: 'said', text: result.spoken, refused: result.intent === 'refused' })
    else setEcho(null)
  }, [])

  /** Commit the shown decision — once; the echo turns into what Sous did. */
  const commitDecision = useCallback(
    (decision: Decision, target?: string, ack?: CommitAck) => {
      const api = cookrew()
      hold.current = null
      setEcho({ kind: 'said', text: '…', refused: false })
      if (!api.sousCommit) {
        setEcho({ kind: 'said', text: 'This build cannot commit a decision.', refused: true })
        return
      }
      setBusy(true)
      void api
        .sousCommit(decision.token, { ...(target ? { target } : {}), ...(ack ? { ack } : {}) }, isPhone ? 'phone' : 'canvas')
        .then((result) => {
          setBusy(false)
          say({ ...result, spoken: commitToast(result.spoken, decision) })
          setText('')
          setDraft(false)
        })
        .catch(() => {
          setBusy(false)
          setEcho({ kind: 'said', text: 'That did not go through. Say it again.', refused: true })
        })
    },
    [say]
  )

  /** A decision arrives: the machine starts the hold; the echo draws it. */
  const showDecision = useCallback(
    (decision: Decision) => {
      hold.current?.close()
      setAlts(false)
      setEcho({ kind: 'decision', decision, left: decision.holdMs })
      hold.current = createHold(decision, {
        holdMs: decision.holdMs,
        onTick: (left) => setEcho((e) => (e && e.kind === 'decision' && e.decision.token === decision.token ? { ...e, left } : e)),
        onCommit: (target, ack) => commitDecision(decision, target, ack),
        onCancel: (token) => void cookrew().sousCancel?.(token, isPhone ? 'phone' : 'canvas').catch(() => undefined)
      })
    },
    [commitDecision]
  )

  // HP: a late revision appends alternates to the decision on the line — and
  // nothing else about it changes, whatever the frame says.
  useEffect(() => {
    const off = cookrew().onSousDecisionUpdated?.((update) => {
      if (!isDecisionUpdate(update)) return
      setEcho((e) => {
        if (!e || e.kind !== 'decision' || e.decision.token !== update.token || e.decision.kind === 'question') return e
        return { ...e, decision: { ...e.decision, alternates: appendAlternates(e.decision.alternates, update.alternates as Alternate[]) } }
      })
    })
    return () => off?.()
  }, [])

  /** The box goes away: a held decision is cancelled, never committed unseen. */
  const dismiss = useCallback(() => {
    hold.current?.close()
    hold.current = null
    setEcho((e) => (e && e.kind === 'decision' ? null : e))
    setAlts(false)
  }, [])

  // Closing clears the field as well: reopening starts empty.
  useEffect(() => {
    if (!open) {
      dismiss()
      setText('')
      setDraft(false)
    }
  }, [open, dismiss])
  useEffect(
    () => () => {
      hold.current?.close()
      if (slotTimer.current !== null) window.clearTimeout(slotTimer.current)
    },
    []
  )

  // What Sous said fades; a decision does not.
  useEffect(() => {
    if (!echo || echo.kind !== 'said' || echo.text === '…') return
    const timer = window.setTimeout(() => setEcho(null), SAID_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [echo])

  const submit = (): void => {
    if (echo?.kind === 'decision' && hold.current) {
      // The same sentence commits the held decision — unless the act is
      // exposed, when Enter only takes the owner to SEND ANYWAY. A changed
      // sentence is a new brief: the held decision is cancelled, the text goes to Sous.
      const action = enterAction(echo.decision, text)
      if (action === 'commit') {
        hold.current.commit()
        return
      }
      if (action === 'focus-send-anyway') {
        hold.current.pause()
        sendAnyway.current?.focus()
        return
      }
      if (action === 'nothing') return
      dismiss()
    }
    const sentence = text.trim()
    if (!sentence || busy) return
    setBusy(true)
    setDraft(false)
    void cookrew()
      .sousCommand(sentence, { surface: isPhone ? 'phone' : 'canvas', box: true })
      .then((result) => {
        setBusy(false)
        if (result.intent === 'decide' && result.decision) showDecision(result.decision)
        else {
          say(result)
          setText('')
        }
      })
      .catch(() => {
        setBusy(false)
        setEcho({ kind: 'said', text: 'Sous did not answer.', refused: true })
      })
  }

  /**
   * One click, the right input. The jump switches workspaces when it must and
   * zooms the card — the note the producer named for a secret, else the card
   * itself. A zoomed terminal takes focus on open, a zoomed browser is its own
   * interactive view, and a secret slot is found by the hook agreed with the
   * sealed-note lane: `[data-secret-slot="<name>"]` holding a focusable input.
   */
  const go = (row: InboxRow): void => {
    dismiss()
    const landing = row.kind === 'secret' && row.noteId ? row.noteId : row.nodeId
    void jumpToNode(row.workspaceId, landing).then((outcome) => {
      if (outcome === 'missed') return
      if (row.kind === 'secret' && row.slot) focusSlot(row.slot, 8, slotTimer)
      onClose()
    })
  }

  /** A sous row's act: RETRY re-dispatches in main, OPEN is the jump; DISMISS drops the row. */
  const act = (row: InboxRow, what: 'retry' | 'open' | 'dismiss'): void => {
    if (what === 'open') {
      go(row)
      return
    }
    const api = cookrew()
    const call = what === 'retry' ? api.inboxAct : api.inboxDismiss
    if (!call) return
    void call(inboxRowId(row))
      .then((out) => {
        if (out.ok && what === 'dismiss') setRows((list) => list.filter((r) => inboxRowId(r) !== inboxRowId(row)))
      })
      .catch(() => undefined)
  }

  const ordered = useMemo(() => (isPhone ? rows.slice(0, 3) : rows.slice(0, 6)), [rows, isPhone])
  const now = Date.now()

  if (!open) return null
  return (
    <div className={`cmd${isPhone ? ' phone' : ''}`} role="dialog" aria-label="Command and inbox">
      {ordered.length > 0 && (
        <ul className="cmd-rows" aria-label="Waiting on you">
          {ordered.map((row) => {
            const actions = sousRowActions(row)
            if (row.kind === 'sous') {
              return (
                <li key={inboxRowId(row)}>
                  <div className="cmd-row" data-kind="sous" role="group" aria-label={`Sous · ${row.nodeName}`}>
                    <span className="k" aria-hidden="true">{INBOX_MARK.sous}</span>
                    <span className="who" title={row.text ?? row.reasons[0]}>
                      <b>{row.nodeName}</b>
                      <span>{row.text ?? row.reasons[0]}</span>
                    </span>
                    <span className="wait">{waitedFor(Math.max(0, (now - row.since) / 60_000))}</span>
                    {actions.act !== null ? (
                      <button type="button" className="act" onClick={() => act(row, actions.act!)}>
                        {actions.act === 'retry' ? 'RETRY' : 'OPEN'}
                      </button>
                    ) : (
                      <span />
                    )}
                    {actions.dismiss ? (
                      <button type="button" className="dismiss" onClick={() => act(row, 'dismiss')}>
                        DISMISS
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                </li>
              )
            }
            return (
              <li key={inboxRowId(row)}>
                <button className={`cmd-row${row.served ? ' served' : ''}`} data-kind={row.kind} onClick={() => go(row)}>
                  <span className="k" aria-hidden="true">{INBOX_MARK[row.kind]}</span>
                  <span className="who">
                    <b>{row.nodeName}</b>
                    <span>{row.reasons[0]}</span>
                  </span>
                  <span className="wait">{waitedFor(Math.max(0, (now - row.since) / 60_000))}</span>
                  <span className="blocks">{row.blockedDownstream > 0 ? `blocks ${row.blockedDownstream}` : ''}</span>
                  <span className="go" aria-hidden="true">›</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="cmd-field">
        <span className="key" aria-hidden="true">⌘K</span>
        <input
          ref={field}
          value={text}
          placeholder="Tell the crew what to do…"
          aria-label="Tell the crew what to do"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value)
            setDraft(false)
            // Typing while a decision is held: the owner is changing their mind — nothing commits.
            hold.current?.pause()
          }}
          onKeyDown={(e) => {
            if (enterSubmits(e)) {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              // Ours, not the zoomed card's behind us.
              e.preventDefault()
              e.stopPropagation()
              if (echo?.kind === 'decision') dismiss()
              else onClose()
            }
          }}
        />
        {draft && text.trim().length > 0 && (
          <span className="cmd-draft" role="status">
            draft from earlier —
            <button
              type="button"
              onClick={() => {
                setText('')
                setDraft(false)
                field.current?.focus()
              }}
            >
              clear?
            </button>
          </span>
        )}
        {busy && <span className="busy">…</span>}
        {/* The phone has no Escape key: the sheet closes by its own ✕. */}
        {isPhone && (
          <button type="button" className="cmd-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        )}
      </div>
      {echo && echo.kind === 'decision' && (
        <div className="cmd-echo" role="status" aria-live="polite" data-decision={echo.decision.kind} data-mode={holdMode(echo.decision)}>
          <span className="line">{echoLine(echo.decision)}</span>
          <span className="mode">{modeBadge(echo.decision, hold.current?.state ?? (holdMode(echo.decision) === 'ticking' ? 'ticking' : 'paused'), echo.left)}</span>
          {echo.decision.kind !== 'question' && holdMode(echo.decision) !== 'answer' && (
            <>
              {echo.decision.alternates.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    // Choosing pauses the hold: nothing commits to the first target while the list is open.
                    hold.current?.pause()
                    setAlts((v) => !v)
                  }}
                >
                  change ▾
                </button>
              )}
              {needsSendAnyway(echo.decision) && (
                <div className="cmd-boundary" role="group" aria-label="Boundaries">
                  <span className="line">⚠ {echo.decision.boundaries ?? echo.decision.exposureWhy ?? 'this act leaves the machine'}</span>
                  <button ref={sendAnyway} type="button" className="send-anyway" onClick={() => hold.current?.commit(undefined, 'send-anyway')}>
                    SEND ANYWAY
                  </button>
                </div>
              )}
              {alts && (
                <span className="cmd-alts">
                  {echo.decision.alternates.map((alt) => (
                    <button key={alt.id} type="button" data-alt={alt.kind} onClick={() => hold.current?.commit(alt.id, needsSendAnyway(echo.decision) ? 'send-anyway' : undefined)}>
                      {altLabel(alt)} ({alt.reasons.join(' · ')})
                    </button>
                  ))}
                </span>
              )}
            </>
          )}
        </div>
      )}
      {echo && echo.kind === 'said' && (
        <div className={`cmd-echo said${echo.refused ? ' refused' : ''}`} role="status" aria-live="polite">
          <span className="line">{echo.text}</span>
        </div>
      )}
    </div>
  )
}

/** The model a decision runs on, from `decision.route`: effective, else the route pinned at start; `—` when main said null; nothing on an older main. */
export function routeLabel(decision: Pick<Decision, 'route'>): string | null {
  if (decision.route === undefined) return null
  if (decision.route === null) return '—'
  return decision.route.effective ?? `${decision.route.route} (pinned at start)`
}

/** What Sous said after the commit, with the model the card runs on when the decision carried one: `Sent to Forge · deepseek/deepseek-v4`. */
export function commitToast(spoken: string, decision: Pick<Decision, 'route'>): string {
  const model = decision.route?.effective ?? null
  return spoken && model ? `${spoken} · ${model}` : spoken
}

/** The line under the box: who, the model, and the three reasons, or the question back. A recruit that runs direct says so. */
export function echoLine(decision: Decision): string {
  const model = routeLabel(decision)
  const on = model === null ? '' : ` · ${model}`
  if (decision.kind === 'ask') return `→ ${decision.target.name}${on} (${decision.reasons.join(' · ')})`
  if (decision.kind === 'recruit') return `+ ${decision.harness} card · ${decision.name}${on} (${decision.reasons.join(' · ')})${decision.direct ? ' · will run direct' : ''}`
  return decision.question
}

/** The other path, named as the thing it does: a new card, or a card instead. */
export function altLabel(alt: Alternate): string {
  return alt.kind === 'recruit' ? `+ new ${alt.harness ?? alt.name} card` : `→ ${alt.name} instead`
}

/** The sealed-note slot renders after the zoom; look a few times, then give up quietly. The timer is the box's to clear. */
function focusSlot(name: string, tries: number, timer: { current: number | null }): void {
  const el = document.querySelector<HTMLElement>(`[data-secret-slot="${CSS.escape(name)}"] input, [data-secret-slot="${CSS.escape(name)}"] textarea`)
  timer.current = null
  if (el) {
    el.focus()
    return
  }
  if (tries > 0) timer.current = window.setTimeout(() => focusSlot(name, tries - 1, timer), 300)
}
