import { useCallback, useEffect, useRef, useState } from 'react'
import { cookrew } from '../api'
import { rememberHarness } from '../prompt/harness-pref'
import { SetupScreen } from '../routing/SetupScreen'
import { runningLabel, type SetupRunning } from '../routing/setup-line-state'
import type { RunOptions, RunOutcome, SetupEnded, SetupError } from '../routing/use-setup-terminal'
import { PREFLIGHT_COPY, SETUP_LINE_COPY } from '../../../shared/first-run-copy'
import { mayContinue, preflightRows, UNKNOWN_FACTS, type PreflightRow, type ToolState } from '../../../shared/preflight'
import { AccessRows } from './AccessRows'
import { RemoteRows } from './RemoteRows'
import { firstAgentHarness, stillMissing } from './first-run-rules'
import { firstRun } from './first-run-state'

/**
 * THE TOOL CHECK: one calm row per tool, no account in sight. A missing tool
 * has one press, and the press is a line in the ordinary Setup terminal card
 * (use-setup-terminal.ts), drawn right here so its questions can be answered.
 * The check runs again by itself when that line ends, which main reads from its
 * exit status (main/setup-line.ts), and when the person comes back to this window
 * from a download page. While a line runs the screen says so and offers Stop:
 * nothing here waits on a press the person was not told about.
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
  stuck = false,
  error,
  onRun,
  onStop,
  onCheck,
  onContinue,
  onSkip,
  pane,
  children
}: {
  /** Null while the first check runs. */
  rows: readonly PreflightRow[] | null
  running: SetupRunning | null
  /** A press found the pane taken: the sentence is in `error`, and Stop clears it. */
  stuck?: boolean
  error: string | null
  onRun: (line: string) => void
  onStop?: () => void
  onCheck: () => void
  onContinue: () => void
  onSkip: () => void
  /** The Setup terminal, once a press made it: right under the sentence that points at it. */
  pane?: React.ReactNode
  /** The rest, under the terminal. */
  children?: React.ReactNode
}): React.JSX.Element {
  const open = rows !== null && mayContinue(rows)
  const live = useRef<HTMLDivElement>(null)
  const hasPane = pane !== undefined && pane !== null && pane !== false
  // What it asks and where to answer it arrive together, on screen, with no scroll.
  useEffect(() => {
    if (running !== null || stuck) live.current?.scrollIntoView({ block: 'nearest' })
  }, [running?.line, running?.asking, stuck, hasPane, rows === null, error])
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
              <Row key={row.id} row={row} running={running} held={running !== null} onRun={onRun} />
            ))}
          </ul>
        )}
        {error && (
          <p className="fr-error" role="alert">
            {error}
          </p>
        )}
        <div ref={live}>
          {(running !== null || stuck) && (
            <p className="fr-running" role="status">
              {running !== null && <span>{running.asking === 'password' ? SETUP_LINE_COPY.PASSWORD : SETUP_LINE_COPY.WAITING}</span>}
              <button type="button" className="fr-quiet" onClick={onStop}>
                {SETUP_LINE_COPY.STOP}
              </button>
            </p>
          )}
          {pane}
        </div>
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
  ended: SetupEnded | null
  stuck: boolean
  stop: () => void
}

export function Preflight({ setup, onDone }: { setup: PreflightSetup; onDone: () => void }): React.JSX.Element {
  const [rows, setRows] = useState<readonly PreflightRow[] | null>(null)
  /** Set by the first press: until then there is no terminal to look at. */
  const [pressed, setPressed] = useState(false)
  /** A line ended well and its tool is still not found. */
  const [notFound, setNotFound] = useState<string | null>(null)
  const live = useRef(true)
  /** A check reads the login shell: one at a time, however often the window takes focus. */
  const checking = useRef(false)
  /** What the last line left to say once the check after it has answered; a line's end is never dropped. */
  const afterLine = useRef<{ ended: SetupEnded | null } | null>(null)
  const check = useCallback(() => {
    if (checking.current) return
    checking.current = true
    const after = afterLine.current
    afterLine.current = null
    void (cookrew().firstRunPreflight?.() ?? Promise.resolve(UNKNOWN_ROWS))
      .catch(() => UNKNOWN_ROWS)
      .then((next) => {
        if (!live.current) return
        setRows(next)
        if (after !== null) setNotFound(stillMissing(next, after.ended))
      })
      .finally(() => {
        checking.current = false
        if (afterLine.current !== null) check()
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
    if (wasRunning.current && setup.running === null) {
      afterLine.current = { ended: setup.ended }
      check()
    }
    wasRunning.current = setup.running !== null
  }, [setup.running, setup.ended, check])
  const onward = async (): Promise<void> => {
    const access = await cookrew()
      .accessState?.()
      .catch(() => null)
    const harness = firstAgentHarness(rows ?? [], access?.active?.tools ?? null)
    if (harness) rememberHarness(harness)
    void firstRun.advance('task')
    onDone()
  }
  return (
    <PreflightView
      rows={rows}
      running={setup.running}
      stuck={setup.stuck}
      error={setup.error?.text ?? (notFound === null ? null : SETUP_LINE_COPY.STILL_MISSING(notFound))}
      onRun={(line) => {
        setPressed(true)
        setNotFound(null)
        void setup.run(line)
      }}
      onStop={setup.stop}
      onCheck={check}
      onContinue={() => void onward()}
      // On to the first screen, which keeps the way back here: skipping is not leaving.
      onSkip={() => void onward()}
      pane={
        (pressed || setup.running !== null || setup.stuck) && setup.terminalId ? (
          <div className="fr-setup">
            <p className="fr-setup-title">{PREFLIGHT_COPY.SETUP_TITLE}</p>
            <SetupScreen terminalId={setup.terminalId} focusTick={setup.focusTick} fit="width" prompting={setup.running?.asking === 'password'} />
          </div>
        ) : null
      }
    >
      <AccessRows onChange={check} />
      <RemoteRows />
    </PreflightView>
  )
}
