import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cookrew, isRemoteMode } from './api'
import { useCanvasUi } from './canvas-ui'
import { createHold, enterSubmits, type Hold } from './decision-hold'
import { waitedFor, type InboxRow } from '../../shared/inbox-rank'
import { INBOX_MARK } from '../../shared/inbox-copy'
import type { Decision, SousCommandResult } from '../../main/sous-control'
import './command-box.css'

/**
 * THE ONE BOX (route program R3 — design sections 4 and 5, mock
 * docs/ui-magpie/r3-command-inbox.html). It is two things in one place:
 *
 *   the command line to Sous: a sentence in, the DECISION out as the line
 *   under the box — who, and the three reasons — held for a beat so the owner
 *   can change it, committed on Enter at once;
 *
 *   the HITL inbox: when something only a person can move is waiting, the
 *   rows sit ABOVE the box (card · reason · waited for · what it blocks), and
 *   one click lands in that card with the right input focused.
 *
 * Desktop: ⌘K shows it, Esc hides it. Phone: it is the bottom bar and is
 * always there. Both read the same rows and talk to the same Sous.
 *
 * THE HOLD IS A MACHINE (decision-hold.ts), not an effect on the echo: closing
 * the box cancels it and tells main to drop the token; a keystroke or
 * "change" pauses it; Enter and the alternate commit it once.
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
}

type Echo = { kind: 'decision'; decision: Decision; left: number } | { kind: 'said'; text: string; refused: boolean }

export function CommandBox({ open, onClose, phone, rows: givenRows, initialDecision = null }: CommandBoxProps): React.JSX.Element | null {
  const { jumpToNode } = useCanvasUi()
  const [rows, setRows] = useState<InboxRow[]>(givenRows ?? [])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [echo, setEcho] = useState<Echo | null>(initialDecision ? { kind: 'decision', decision: initialDecision, left: initialDecision.holdMs } : null)
  const [alts, setAlts] = useState(false)
  const [, setClock] = useState(0)
  const field = useRef<HTMLInputElement>(null)
  const hold = useRef<Hold | null>(null)
  const slotTimer = useRef<number | null>(null)
  const isPhone = phone ?? isRemoteMode()

  // The rows: the subscription holds the list open in main and delivers the
  // opening rows; a bridge without one falls back to a single read.
  useEffect(() => {
    if (givenRows) return
    const api = cookrew()
    let alive = true
    const off = api.onInbox?.((list) => alive && setRows(list))
    if (!off) void api.inbox?.().then((list) => alive && setRows(list)).catch(() => undefined)
    return () => {
      alive = false
      off?.()
    }
  }, [givenRows])

  // The printed wait comes from `since` and moves once a minute.
  useEffect(() => {
    if (rows.length === 0) return
    const timer = window.setInterval(() => setClock((c) => c + 1), WAIT_TICK_MS)
    return () => window.clearInterval(timer)
  }, [rows.length])

  useEffect(() => {
    if (open && !isPhone) field.current?.focus()
  }, [open, isPhone])

  const say = useCallback((result: SousCommandResult) => {
    if (result.spoken) setEcho({ kind: 'said', text: result.spoken, refused: result.intent === 'refused' })
    else setEcho(null)
  }, [])

  /** Commit the shown decision — once; the echo turns into what Sous did. */
  const commitDecision = useCallback(
    (decision: Decision, target?: string) => {
      const api = cookrew()
      hold.current = null
      setEcho({ kind: 'said', text: '…', refused: false })
      if (!api.sousCommit) {
        setEcho({ kind: 'said', text: 'This build cannot commit a decision.', refused: true })
        return
      }
      setBusy(true)
      void api
        .sousCommit(decision.token, target ? { target } : {})
        .then((result) => {
          setBusy(false)
          say(result)
          setText('')
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
        onCommit: (target) => commitDecision(decision, target),
        onCancel: (token) => void cookrew().sousCancel?.(token).catch(() => undefined)
      })
    },
    [commitDecision]
  )

  /** The box goes away: a held decision is cancelled, never committed unseen. */
  const dismiss = useCallback(() => {
    hold.current?.close()
    hold.current = null
    setEcho((e) => (e && e.kind === 'decision' ? null : e))
    setAlts(false)
  }, [])

  useEffect(() => {
    if (!open && !isPhone) dismiss()
  }, [open, isPhone, dismiss])
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
    const timer = window.setTimeout(() => setEcho(null), 3500)
    return () => window.clearTimeout(timer)
  }, [echo])

  const submit = (): void => {
    if (echo?.kind === 'decision' && hold.current) {
      hold.current.commit()
      return
    }
    const sentence = text.trim()
    if (!sentence || busy) return
    setBusy(true)
    void cookrew()
      .sousCommand(sentence, { surface: isPhone ? 'phone' : 'canvas' })
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
      if (!isPhone) onClose()
    })
  }

  const ordered = useMemo(() => (isPhone ? rows.slice(0, 3) : rows.slice(0, 6)), [rows, isPhone])
  const now = Date.now()

  if (!open && !isPhone) return null
  return (
    <div className={`cmd${isPhone ? ' phone' : ''}`} role="dialog" aria-label="Command and inbox">
      {ordered.length > 0 && (
        <ul className="cmd-rows" aria-label="Waiting on you">
          {ordered.map((row) => (
            <li key={row.nodeId}>
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
          ))}
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
        {busy && <span className="busy">…</span>}
      </div>
      {echo && echo.kind === 'decision' && (
        <div className="cmd-echo" role="status" aria-live="polite" data-decision={echo.decision.kind}>
          <span className="line">{echoLine(echo.decision)}</span>
          {echo.decision.kind !== 'question' && (
            <>
              <span className="hold">{hold.current?.state === 'paused' ? 'paused · ↵ to send' : `${(echo.left / 1000).toFixed(1)} s · or ↵ now`}</span>
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
              {alts && (
                <span className="cmd-alts">
                  {echo.decision.alternates.map((alt) => (
                    <button key={alt.id} type="button" onClick={() => hold.current?.commit(alt.id)}>
                      → {alt.name} ({alt.reasons.join(' · ')})
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

/** The line under the box: who and the three reasons, or the question back. */
export function echoLine(decision: Decision): string {
  if (decision.kind === 'ask') return `→ ${decision.target.name} (${decision.reasons.join(' · ')})`
  if (decision.kind === 'recruit') return `+ ${decision.harness} card · ${decision.name} (${decision.reasons.join(' · ')})`
  return decision.question
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
