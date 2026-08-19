// A stray promise must not be able to kill the fleet.
//
// Node ≥15 treats an unhandled rejection as fatal: it prints the reason and
// exits(1). In a browser tab that is a page reload; here the process holds
// every agent's PTY, the dispatch ledger, and the mobile server, and its death
// SIGHUPs the panes behind it. The wave-C factory made that concrete — an
// instantiate whose server-side work had already succeeded took the whole app
// down 25-35s in, silently, with no crash report, because ONE background
// promise rejected with nobody awaiting it.
//
// Each individual rejection source is worth fixing on its own (and the factory
// ones were). This is the structural half: the property that any future one
// takes everything with it. So:
//
//   unhandledRejection — logged, recorded, SURVIVED. A background fault is a
//                        defect to fix tomorrow, never a reason to drop every
//                        agent tonight.
//   uncaughtException  — the process state is genuinely suspect, so it does
//                        exit — but it FLUSHES first (store, turns, events).
//                        app.exit does NOT emit `before-quit`, and that is the
//                        point: a process in this state must not depend on the
//                        full teardown drain running to completion. The flush
//                        above is what makes skipping it safe.
//
// Both write an ISO timestamp and a one-line reason: the correlation key
// against ~/.config/herdr/sessions/*/herdr-server.log, so "did the app die
// first, or the herdr server?" is answerable from two files side by side
// rather than from process-table archaeology after the fact.

import type { CookrewEvent } from './event-log'

export type FaultKind = 'unhandledRejection' | 'uncaughtException'

export interface FaultSummary {
  kind: FaultKind
  /** ISO-8601, the shared key with herdr's own log. */
  at: string
  /** Error name, or the runtime type of a non-Error rejection value. */
  name: string
  /** First line of the message, truncated. METADATA ONLY — never payload. */
  reason: string
  /** Top stack frame, for the console line. Null when there is no stack. */
  origin: string | null
}

/** Long enough to identify a fault, short enough to never carry a prompt. */
const REASON_MAX = 200

/**
 * Reduce a thrown value to metadata.
 *
 * A rejection value can be anything — an Error, a string, an API response
 * object holding a user's prompt. Only the first line is kept and it is
 * truncated, because this record lands in the observability log, which
 * carries metadata and never conversation content.
 */
export function summarizeFault(kind: FaultKind, value: unknown, at: Date): FaultSummary {
  const error = value instanceof Error ? value : null
  const raw = error ? error.message : typeof value === 'string' ? value : ''
  const firstLine = raw.split('\n')[0]?.trim() ?? ''
  return {
    kind,
    at: at.toISOString(),
    name: error ? error.name : `non-error:${describe(value)}`,
    reason:
      firstLine.length > REASON_MAX ? `${firstLine.slice(0, REASON_MAX - 1)}…` : firstLine,
    origin: topFrame(error)
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function topFrame(error: Error | null): string | null {
  const line = error?.stack?.split('\n')[1]?.trim()
  return line ? line.replace(/^at\s+/, '') : null
}

/** The observability record for a fault — metadata only, by construction. */
export function faultEvent(
  fault: FaultSummary,
  workspace: { id: string; name: string }
): CookrewEvent {
  return {
    type: `app.${fault.kind === 'uncaughtException' ? 'exception' : 'rejection'}`,
    entityId: fault.kind,
    entityName: fault.name,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    actor: 'user',
    timestamp: Date.parse(fault.at),
    // The reason is already reduced to one truncated line by summarizeFault.
    details: fault.origin ? `${fault.reason} @ ${fault.origin}` : fault.reason
  }
}

export interface ProcessGuardDeps {
  /** Append the fault to the observability log. */
  append: (event: CookrewEvent) => void
  /** Where the fault is attributed — the canvas the user was looking at. */
  workspace: () => { id: string; name: string }
  /** Persist everything this process is the only witness to. */
  flush: () => void
  /** app.exit — immediate, and deliberately NOT the `before-quit` drain. */
  exit: (code: number) => void
  /** Injected in tests; defaults to the real process. */
  target?: Pick<NodeJS.Process, 'on'>
  now?: () => Date
  log?: (message: string) => void
}

/**
 * Install both guards. Call once, as early in main as the log and store exist.
 *
 * Nothing here may throw: a guard that faults while reporting a fault would
 * reinstate exactly the silent death it exists to prevent, so recording and
 * flushing are each isolated.
 */
export function installProcessGuards(deps: ProcessGuardDeps): void {
  const target = deps.target ?? process
  const now = deps.now ?? ((): Date => new Date())
  const log = deps.log ?? ((message: string): void => console.error(message))

  const report = (fault: FaultSummary, value: unknown): void => {
    log(
      `[cookrew] ${fault.kind} at ${fault.at}: ${fault.name}: ${fault.reason}` +
        (fault.origin ? ` (${fault.origin})` : '')
    )
    // The full stack goes to stderr only — it can quote source lines, and the
    // event log is metadata.
    if (value instanceof Error && value.stack) log(value.stack)
    try {
      deps.append(faultEvent(fault, deps.workspace()))
    } catch (error) {
      log(`[cookrew] recording the fault failed: ${String(error)}`)
    }
  }

  target.on('unhandledRejection', (reason: unknown) => {
    // Logged and SURVIVED. This is the whole point: a background promise
    // nobody awaited must not be able to end every agent's session.
    report(summarizeFault('unhandledRejection', reason, now()), reason)
  })

  let exiting = false
  target.on('uncaughtException', (error: Error) => {
    report(summarizeFault('uncaughtException', error, now()), error)
    // A second exception DURING teardown must not restart teardown.
    if (exiting) return
    exiting = true
    try {
      deps.flush()
    } catch (flushError) {
      log(`[cookrew] flush during fatal teardown failed: ${String(flushError)}`)
    }
    deps.exit(1)
  })
}
