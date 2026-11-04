import { useCallback, useEffect, useRef, useState } from 'react'
import { cookrew } from '../api'
import { rememberHarness } from '../prompt/harness-pref'
import { SetupScreen } from '../routing/SetupScreen'
import { runningLabel, type SetupRunning } from '../routing/setup-line-state'
import type { RunOptions, RunOutcome, SetupError } from '../routing/use-setup-terminal'
import { PREFLIGHT_COPY } from '../../../shared/first-run-copy'
import { mayContinue, preflightRows, UNKNOWN_FACTS, type PreflightRow, type ToolState } from '../../../shared/preflight'
import { firstHarness } from './first-run-rules'
import { firstRun } from './first-run-state'

/**
 * THE TOOL CHECK: one calm row per tool, no account in sight. A missing tool
 * has one press, and the press is a line in the ordinary Setup terminal card
 * (use-setup-terminal.ts), drawn right here so its questions can be answered.
 * The check runs again when that line ends, and when the person comes back to
 * this window from a download page.
 */

/** The bridge itself failed: every row is a check that failed, and the way on stays open. */
const UNKNOWN_ROWS = preflightRows(UNKNOWN_FACTS)

const STATE_WORD: Record<ToolState, string> = {
  found: PREFLIGHT_COPY.FOUND,
  missing: PREFLIGHT_COPY.MISSING,
  unknown: PREFLIGHT_COPY.UNKNOWN
}

function Row({ row, running, held, onRun }: { row: PreflightRow; running: SetupRunning | null; held: boolean; onRun: (line: string) => void }): React.JSX.Element {
  const busy = row.fix ? runningLabel(running, row.fix.line) : null
  return (
    <li className={`fr-row ${row.state}`}>
      <span className="fr-dot" aria-hidden="true" />
      <span className="fr-tool">
        <b>{row.name}</b>
        {row.optional && <span className="fr-optional">{PREFLIGHT_COPY.OPTIONAL}</span>}
        <small>{row.does}</small>
        {row.note && <small className="fr-note">{row.note}</small>}
      </span>
      <span className="fr-act">
        <span className="fr-state">{STATE_WORD[row.state]}</span>
        {row.fix && (
          // One line at a time: a key pressed now belongs to the one running, a password maybe.
          <button type="button" className="fr-fix" disabled={held} title={row.fix.line} onClick={() => row.fix && onRun(row.fix.line)}>
            {busy ?? row.fix.label}
          </button>
        )}
      </span>
    </li>
  )
}

export function PreflightView({
  rows,
  running,
  released = false,
  error,
  onRun,
  onCheck,
  onContinue,
  onSkip,
  children
}: {
  /** Null while the first check runs. */
  rows: readonly PreflightRow[] | null
  running: SetupRunning | null
  /** The person checked again: the fixes are theirs, whatever the pane seems to be doing. */
  released?: boolean
  error: string | null
  onRun: (line: string) => void
  onCheck: () => void
  onContinue: () => void
  onSkip: () => void
  /** The Setup terminal, once a press made it. */
  children?: React.ReactNode
}): React.JSX.Element {
  const open = rows !== null && mayContinue(rows)
  return (
    <section className="fr-stage fr-preflight" aria-label={PREFLIGHT_COPY.TITLE}>
      <div className="fr-col">
        <h1 className="fr-title">{PREFLIGHT_COPY.TITLE}</h1>
        <p className="fr-lede">{PREFLIGHT_COPY.LEDE}</p>
        {rows === null ? (
          <p className="fr-checking">{PREFLIGHT_COPY.CHECKING}</p>
        ) : (
          <ul className="fr-rows">
            {rows.map((row) => (
              <Row key={row.id} row={row} running={running} held={running !== null && !released} onRun={onRun} />
            ))}
          </ul>
        )}
        {error && (
          <p className="fr-error" role="alert">
            {error}
          </p>
        )}
        {children}
        <div className="fr-foot">
          <button type="button" className="fr-go" disabled={!open} onClick={onContinue}>
            {PREFLIGHT_COPY.CONTINUE}
          </button>
          <button type="button" className="fr-quiet" onClick={onCheck}>
            {PREFLIGHT_COPY.CHECK_AGAIN}
          </button>
          {rows !== null && !open && (
            <>
              <span className="fr-why">{PREFLIGHT_COPY.NEEDS_ONE}</span>
              <button type="button" className="fr-quiet" onClick={onSkip}>
                {PREFLIGHT_COPY.SKIP}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

export interface PreflightSetup {
  terminalId: string | null
  run: (line: string, options?: RunOptions) => Promise<RunOutcome>
  focusTick: number
  error: SetupError | null
  running: SetupRunning | null
}

export function Preflight({ setup }: { setup: PreflightSetup }): React.JSX.Element {
  const [rows, setRows] = useState<readonly PreflightRow[] | null>(null)
  /** Set by the first press: until then there is no terminal to look at. */
  const [pressed, setPressed] = useState(false)
  /** The end of a line is read off the shell's prompt, and not every prompt can be read. */
  const [released, setReleased] = useState(false)
  const live = useRef(true)
  /** A check reads the login shell: one at a time, however often the window takes focus. */
  const checking = useRef(false)
  const check = useCallback(() => {
    if (checking.current) return
    checking.current = true
    void (cookrew().firstRunPreflight?.() ?? Promise.resolve(UNKNOWN_ROWS))
      .then((next) => live.current && setRows(next))
      .catch(() => live.current && setRows(UNKNOWN_ROWS))
      .finally(() => {
        checking.current = false
      })
  }, [])
  useEffect(() => {
    live.current = true
    check()
    window.addEventListener('focus', check)
    return () => {
      live.current = false
      window.removeEventListener('focus', check)
    }
  }, [check])
  // A line ended: what it installed is the next answer.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && setup.running === null) check()
    wasRunning.current = setup.running !== null
  }, [setup.running, check])
  const onward = (): void => {
    const harness = rows ? firstHarness(rows) : null
    if (harness) rememberHarness(harness)
    void firstRun.advance('task')
  }
  return (
    <PreflightView
      rows={rows}
      running={setup.running}
      released={released}
      error={setup.error?.text ?? null}
      onRun={(line) => {
        setPressed(true)
        setReleased(false)
        void setup.run(line)
      }}
      onCheck={() => {
        setReleased(true)
        check()
      }}
      onContinue={onward}
      // No agent tool at all: the first screen could only make a card that dies, so this leaves the run.
      onSkip={() => void firstRun.advance('closed')}
    >
      {pressed && setup.terminalId && (
        <div className="fr-setup" ref={(el) => el?.scrollIntoView({ block: 'nearest' })}>
          <p className="fr-setup-title">{PREFLIGHT_COPY.SETUP_TITLE}</p>
          <SetupScreen terminalId={setup.terminalId} focusTick={setup.focusTick} />
        </div>
      )}
    </PreflightView>
  )
}
