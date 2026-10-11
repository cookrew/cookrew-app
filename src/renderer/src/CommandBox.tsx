import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cookrew, isRemoteMode } from './api'
import { useCanvasUi } from './canvas-ui'
import { waitedFor, type InboxRow } from '../../shared/inbox-rank'
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
 */

const ICON: Record<InboxRow['kind'], string> = { waiting: '?', secret: '🔑', dispatch: '!', signin: '🌐' }
const HOLD_TICK_MS = 100

export interface CommandBoxProps {
  open: boolean
  onClose: () => void
  phone?: boolean
  /** Test seam: the rows to draw instead of the bridge's. */
  rows?: InboxRow[]
  /** Test seam: a decision already on the line. */
  initialDecision?: Decision | null
}

type Echo = { kind: 'decision'; decision: Decision; line: string; left: number } | { kind: 'said'; text: string; refused: boolean }

export function CommandBox({ open, onClose, phone, rows: givenRows, initialDecision = null }: CommandBoxProps): React.JSX.Element | null {
  const { jumpToNode } = useCanvasUi()
  const [rows, setRows] = useState<InboxRow[]>(givenRows ?? [])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [echo, setEcho] = useState<Echo | null>(initialDecision ? { kind: 'decision', decision: initialDecision, line: echoLine(initialDecision), left: initialDecision.holdMs } : null)
  const [alts, setAlts] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const isPhone = phone ?? isRemoteMode()

  // The rows: once on mount, then on every change the bridge announces.
  useEffect(() => {
    if (givenRows) return
    const api = cookrew()
    let alive = true
    void api.inbox?.().then((list) => alive && setRows(list)).catch(() => undefined)
    const off = api.onInbox?.((list) => alive && setRows(list))
    return () => {
      alive = false
      off?.()
    }
  }, [givenRows])

  useEffect(() => {
    if (open && !isPhone) field.current?.focus()
  }, [open, isPhone])

  const show = useCallback((result: SousCommandResult) => {
    if (result.intent === 'decide' && result.decision) {
      setEcho({ kind: 'decision', decision: result.decision, line: echoLine(result.decision), left: result.decision.holdMs })
      setAlts(false)
      return
    }
    if (result.spoken) setEcho({ kind: 'said', text: result.spoken, refused: result.intent === 'refused' })
    else setEcho(null)
  }, [])

  /** Commit the shown decision — once; the echo turns into what Sous did. */
  const commit = useCallback(
    (decision: Decision, target?: string) => {
      const api = cookrew()
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
          show(result)
          setText('')
        })
        .catch(() => {
          setBusy(false)
          setEcho({ kind: 'said', text: 'That did not go through. Say it again.', refused: true })
        })
    },
    [show]
  )

  // The hold: the echo counts down and commits on its own unless Enter or a
  // change gets there first. A question has no token to commit.
  useEffect(() => {
    if (!echo || echo.kind !== 'decision' || echo.decision.kind === 'question') return
    if (echo.left <= 0) {
      commit(echo.decision)
      return
    }
    const timer = window.setTimeout(() => setEcho((e) => (e && e.kind === 'decision' ? { ...e, left: e.left - HOLD_TICK_MS } : e)), HOLD_TICK_MS)
    return () => window.clearTimeout(timer)
  }, [echo, commit])

  // What Sous said fades; a decision does not.
  useEffect(() => {
    if (!echo || echo.kind !== 'said' || echo.text === '…') return
    const timer = window.setTimeout(() => setEcho(null), 3500)
    return () => window.clearTimeout(timer)
  }, [echo])

  const submit = (): void => {
    if (echo?.kind === 'decision' && echo.decision.kind !== 'question') {
      commit(echo.decision)
      return
    }
    const sentence = text.trim()
    if (!sentence || busy) return
    setBusy(true)
    void cookrew()
      .sousCommand(sentence, { surface: isPhone ? 'phone' : 'canvas' })
      .then((result) => {
        setBusy(false)
        show(result)
        if (result.intent !== 'decide') setText('')
      })
      .catch(() => {
        setBusy(false)
        setEcho({ kind: 'said', text: 'Sous did not answer.', refused: true })
      })
  }

  /**
   * One click, the right input. The jump switches workspaces when it must and
   * zooms the card; a zoomed terminal takes focus on open, a zoomed browser
   * is its own interactive view, and a note's secret slot is found by the
   * hook agreed with the sealed-note lane: `[data-secret-slot="<name>"]`
   * holding a focusable input.
   */
  const go = (row: InboxRow): void => {
    void jumpToNode(row.workspaceId, row.nodeId).then((outcome) => {
      if (outcome === 'missed') return
      if (row.kind === 'secret' && row.slot) focusSlot(row.slot, 8)
      if (!isPhone) onClose()
    })
  }

  const ordered = useMemo(() => (isPhone ? rows.slice(0, 3) : rows.slice(0, 6)), [rows, isPhone])

  if (!open && !isPhone) return null
  return (
    <div className={`cmd${isPhone ? ' phone' : ''}`} role="dialog" aria-label="Command and inbox">
      {ordered.length > 0 && (
        <ul className="cmd-rows" aria-label="Waiting on you">
          {ordered.map((row) => (
            <li key={row.nodeId}>
              <button className={`cmd-row${row.served ? ' served' : ''}`} data-kind={row.kind} onClick={() => go(row)}>
                <span className="k" aria-hidden="true">{ICON[row.kind]}</span>
                <span className="who">
                  <b>{row.nodeName}</b>
                  <span>{row.reasons[0]}</span>
                </span>
                <span className="wait">{waitedFor(row.waitMinutes)}</span>
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
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              if (echo?.kind === 'decision') setEcho(null)
              else onClose()
            }
          }}
        />
        {busy && <span className="busy">…</span>}
      </div>
      {echo && echo.kind === 'decision' && (
        <div className="cmd-echo" role="status" aria-live="polite" data-decision={echo.decision.kind}>
          <span className="line">{echo.line}</span>
          {echo.decision.kind !== 'question' && (
            <>
              <span className="hold">{(echo.left / 1000).toFixed(1)} s · or ↵ now</span>
              {echo.decision.alternates.length > 0 && (
                <button type="button" onClick={() => setAlts((v) => !v)}>
                  change ▾
                </button>
              )}
              {alts && (
                <span className="cmd-alts">
                  {echo.decision.alternates.map((alt) => (
                    <button key={alt.id} type="button" onClick={() => commit(echo.decision, alt.id)}>
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

/** The sealed-note slot renders after the zoom; look a few times, then give up quietly. */
function focusSlot(name: string, tries: number): void {
  const el = document.querySelector<HTMLElement>(`[data-secret-slot="${CSS.escape(name)}"] input, [data-secret-slot="${CSS.escape(name)}"] textarea`)
  if (el) {
    el.focus()
    return
  }
  if (tries > 0) window.setTimeout(() => focusSlot(name, tries - 1), 300)
}
