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

/** How long one fault's window runs. */
export const FAULT_WINDOW_MS = 60_000
/** How many of one fault are recorded in a window; the rest are counted. */
export const FAULTS_PER_WINDOW = 5
/** How many fault rows of ANY kind a window records: a storm of ever-different faults is capped too. */
export const FAULT_ROWS_PER_WINDOW = 50
/** Past this many groups, the closed ones that held nothing back are forgotten. */
const GROUPS_KEPT = 64

/** The faults of one kind a window held back, for the row that says so. */
export interface HeldFaults {
  fault: FaultSummary
  dropped: number
}

/**
 * A FAULT STORM MUST NOT EAT THE LOG (owner, 2026-11-16). On 10-30 one
 * exception in a loop wrote ~64k rows and rotated every other event out of the
 * log the HITL bar and the notifications read. Each fault — its kind, name and
 * the place it was thrown (origin), NOT its message, which often carries a
 * port, an id or a count — is recorded at most `limit` times a window, and all
 * faults together at most `total` times; the rest are counted and handed back
 * once, as one row each, when the window closes. stderr is not throttled: it
 * is not what the bar reads.
 */
export function createFaultThrottle(limit = FAULTS_PER_WINDOW, windowMs = FAULT_WINDOW_MS, total = FAULT_ROWS_PER_WINDOW): {
  take: (fault: FaultSummary, atMs: number) => { record: boolean; suppressed: HeldFaults | null; firstDrop: boolean }
  pending: () => HeldFaults[]
} {
  const groups = new Map<string, { start: number; count: number; dropped: number; fault: FaultSummary }>()
  const keyOf = (fault: FaultSummary): string => `${fault.kind}\u0000${fault.name}\u0000${fault.origin ?? ''}`
  let rows = { start: Number.NEGATIVE_INFINITY, count: 0 }
  /** One more row for the window of every fault; false once that window is full. */
  const roomFor = (atMs: number): boolean => {
    if (atMs - rows.start >= windowMs) rows = { start: atMs, count: 0 }
    if (rows.count >= total) return false
    rows = { ...rows, count: rows.count + 1 }
    return true
  }
  const prune = (atMs: number): void => {
    if (groups.size <= GROUPS_KEPT) return
    for (const [key, g] of [...groups]) if (g.dropped === 0 && atMs - g.start >= windowMs) groups.delete(key)
  }
  const hold = (key: string, group: { start: number; count: number; dropped: number; fault: FaultSummary }) => {
    groups.set(key, { ...group, dropped: group.dropped + 1 })
    return { record: false, suppressed: null, firstDrop: group.dropped === 0 }
  }
  return {
    take(fault, atMs) {
      prune(atMs)
      const key = keyOf(fault)
      const group = groups.get(key)
      if (!group || atMs - group.start >= windowMs) {
        const suppressed = group && group.dropped > 0 ? { fault: group.fault, dropped: group.dropped } : null
        const fresh = { start: atMs, count: 1, dropped: 0, fault }
        if (!roomFor(atMs)) return { ...hold(key, { ...fresh, count: 0 }), suppressed }
        groups.set(key, fresh)
        return { record: true, suppressed, firstDrop: false }
      }
      if (group.count < limit && roomFor(atMs)) {
        groups.set(key, { ...group, count: group.count + 1 })
        return { record: true, suppressed: null, firstDrop: false }
      }
      return hold(key, group)
    },
    /** What every open window holds back, handed over once: the windows are emptied of it. */
    pending() {
      const held = [...groups.entries()].filter(([, g]) => g.dropped > 0)
      for (const [key, g] of held) groups.set(key, { ...g, dropped: 0 })
      return held.map(([, g]) => ({ fault: g.fault, dropped: g.dropped }))
    }
  }
}

/** The one row that says how many of a fault a window held back. */
export function heldFaultEvent(held: HeldFaults, workspace: { id: string; name: string }, at: Date): CookrewEvent {
  const base = faultEvent(held.fault, workspace)
  return {
    ...base,
    type: `${base.type}.suppressed`,
    timestamp: at.getTime(),
    details: `${held.dropped} more in ${Math.round(FAULT_WINDOW_MS / 1000)} s: ${base.details ?? held.fault.reason}`
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
  /** Run `fn` once a fault's window closes; defaults to an unref'd timer. */
  schedule?: (fn: () => void, ms: number) => void
}

/**
 * Install both guards. Call once, as early in main as the log and store exist.
 *
 * Nothing here may throw: a guard that faults while reporting a fault would
 * reinstate exactly the silent death it exists to prevent, so recording and
 * flushing are each isolated.
 */
export function installProcessGuards(deps: ProcessGuardDeps): { releaseHeld: () => void } {
  const target = deps.target ?? process
  const now = deps.now ?? ((): Date => new Date())
  const log = deps.log ?? ((message: string): void => console.error(message))
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number): void => {
      setTimeout(fn, ms).unref?.()
    })
  const throttle = createFaultThrottle()

  /**
   * The event is BUILT inside the try too: deps.workspace() can throw, and so
   * can `log` (EPIPE once stderr is closed). Nothing here may reach the
   * uncaughtException handler, which exits.
   */
  const appendSafely = (build: () => CookrewEvent): void => {
    try {
      deps.append(build())
    } catch (error) {
      try {
        log(`[cookrew] recording the fault failed: ${String(error)}`)
      } catch {
        // stderr is what failed: nowhere left to say so.
      }
    }
  }
  /** Each window's held-back count, as one row each. Never throws. */
  const releaseHeld = (): void => {
    try {
      for (const held of throttle.pending()) appendSafely(() => heldFaultEvent(held, deps.workspace(), now()))
    } catch {
      // See appendSafely.
    }
  }

  const report = (fault: FaultSummary, value: unknown): void => {
    log(
      `[cookrew] ${fault.kind} at ${fault.at}: ${fault.name}: ${fault.reason}` +
        (fault.origin ? ` (${fault.origin})` : '')
    )
    // The full stack goes to stderr only — it can quote source lines, and the
    // event log is metadata.
    if (value instanceof Error && value.stack) log(value.stack)
    const verdict = throttle.take(fault, Date.parse(fault.at))
    const held = verdict.suppressed
    if (held) appendSafely(() => heldFaultEvent(held, deps.workspace(), now()))
    if (verdict.record) appendSafely(() => faultEvent(fault, deps.workspace()))
    // The first one held back opens the timer that says how many were.
    if (verdict.firstDrop) schedule(releaseHeld, FAULT_WINDOW_MS)
  }

  /**
   * Reporting must never itself be fatal. `log` defaults to console.error,
   * which THROWS on EPIPE once stderr is closed — routine in a packaged
   * Electron app. An unwrapped report would then turn a survivable rejection
   * into the abrupt, unflushed death this module exists to prevent: the guard
   * killing the process it guards.
   */
  const reportSafely = (fault: FaultSummary, value: unknown): void => {
    try {
      report(fault, value)
    } catch {
      // Nowhere left to say so — stderr is the thing that failed. Surviving
      // silently beats dying loudly.
    }
  }

  target.on('unhandledRejection', (reason: unknown) => {
    // Logged and SURVIVED. This is the whole point: a background promise
    // nobody awaited must not be able to end every agent's session.
    reportSafely(summarizeFault('unhandledRejection', reason, now()), reason)
  })

  let exiting = false
  target.on('uncaughtException', (error: Error) => {
    // Latched FIRST, before anything that can throw: a second exception
    // arriving mid-report must not restart teardown, and reporting is exactly
    // where a closed stderr throws.
    const reentered = exiting
    exiting = true
    reportSafely(summarizeFault('uncaughtException', error, now()), error)
    if (reentered) return
    // What the storm held back is said before the log is flushed for the last time.
    releaseHeld()
    try {
      deps.flush()
    } catch (flushError) {
      try {
        log(`[cookrew] flush during fatal teardown failed: ${String(flushError)}`)
      } catch {
        // See reportSafely.
      }
    }
    deps.exit(1)
  })
  // A normal quit says what is held back too (index.ts · before-quit).
  return { releaseHeld }
}
