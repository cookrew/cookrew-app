// THE PANE-AGENT RULE — ONE authority, imported by the app AND by the gate.
//
// WHY THIS IS A SEPARATE, PLAIN-ESM MODULE
// ----------------------------------------
// 2026-09-06. scripts/checkpoint-live-gate.mjs had its own copy of "which
// process is this pane's agent": scan `ps -axEo` for COOKREW_TERMINAL_ID and
// take a matching pid. A BACKGROUND job inherits COOKREW_TERMINAL_ID from the
// session that spawned it and writes its own ~/.claude/sessions/<pid>.json —
// so the gate picked the job and printed MISMATCH for Conductor, a card that
// was correctly bound (bound 295d5f1c, "live" a78aa3e5, a background job of
// that very session). The app's oracle had refused `kind === 'bg'` all along.
// Two copies of one rule, and the one that could raise an alarm was the wrong
// one. A gate that cries wolf is how a real mismatch gets ignored.
//
// So the rule lives here, in plain ESM with a .d.mts beside it (the shape
// scripts/perf-eval-lib.mjs already uses in this repo), because the gate must
// run with `node scripts/checkpoint-live-gate.mjs` and NO build step — the app
// may be the thing under suspicion. src/main/claude-session-oracle.ts imports
// this same file, so the two can no longer drift.
//
// SCOPE — pure decisions over facts the caller reads. No fs, no child process.

/** Session ids are UUID-shaped; anything else never reaches a file path. */
export const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isSessionUuid(id) {
  return typeof id === 'string' && SESSION_UUID_RE.test(id)
}

const asIs = (dir) => dir

/**
 * Whether a live holder could be the agent INSIDE a pane.
 *
 * Three refusals, each one an incident:
 *   - `kind === 'bg'`: a pane is never a background agent. The bg job that
 *     inherits the terminal id is exactly what the gate mistook for the pane
 *     on 2026-09-06.
 *   - a malformed session id: it would flow into a transcript path.
 *   - a cwd that is not this terminal's: a recycled pid belonging to some
 *     other process. Compared through `real` because session files are keyed
 *     by the realpath (macOS /tmp -> /private/tmp), not the launch path.
 */
export function isPaneAgent(holder, cwd, real = asIs) {
  if (!holder || holder.kind === 'bg') return false
  if (!isSessionUuid(holder.sessionId)) return false
  if (holder.cwd && real(holder.cwd) !== real(cwd)) return false
  return true
}

/**
 * The session the process in a pane reports, or null when nothing can be said.
 * `panePid` comes from the multiplexer, which is the only thing that knows
 * which of several processes actually owns the pane.
 */
export function paneAgentOf(panePid, holders, cwd, real = asIs) {
  if (panePid === null || panePid === undefined) return null
  if (!Number.isInteger(panePid) || panePid <= 0) return null
  const holder = (holders ?? []).find((h) => h.pid === panePid)
  if (!holder || !isPaneAgent(holder, cwd, real)) return null
  return { pid: holder.pid, sessionId: holder.sessionId }
}

/**
 * Holders that are not a CHILD of another holder in the same set.
 *
 * A background job inherits COOKREW_TERMINAL_ID from the agent that spawned
 * it, so it shows up as a second process claiming the same pane — that is the
 * 2026-09-06 false alarm. `kind === 'bg'` catches the ones claude labels; a
 * nested agent that labels itself interactive is caught here, because the pane
 * agent is the ANCESTOR and a job it spawned is the descendant.
 *
 * Only the gate needs this: inside the app the multiplexer names the pane's
 * pid outright, and this is the cheapest honest substitute for a script that
 * must run with no app and no herdr.
 */
export function withoutDescendantsOfPeers(holders, ppidOf) {
  const pids = new Set((holders ?? []).map((h) => h.pid))
  return (holders ?? []).filter((holder) => {
    for (let pid = ppidOf(holder.pid), hops = 0; pid && hops < 16; pid = ppidOf(pid), hops++) {
      if (pids.has(pid)) return false
    }
    return true
  })
}

/**
 * The pane's agent among every live process that carries this terminal id.
 *
 * The multiplexer's answer wins when there is one. Without it, exactly ONE
 * eligible holder is an answer and anything else is not: zero holders (the
 * agent is gone, or only a background job is left) and two holders (a fork, a
 * nested claude) are both reported as undecidable, never guessed. The caller
 * must render that as UNKNOWN — the whole point of this module is that an
 * alarm is only raised on a fact.
 */
export function resolvePaneAgent({ panePid = null, holders = [], cwd, real = asIs }) {
  if (panePid !== null && panePid !== undefined) {
    const named = paneAgentOf(panePid, holders, cwd, real)
    if (named) return { agent: named, reason: null }
    return { agent: null, reason: `pane pid ${panePid} is not an eligible pane agent` }
  }
  const eligible = (holders ?? []).filter((h) => isPaneAgent(h, cwd, real))
  if (eligible.length === 1) {
    return { agent: { pid: eligible[0].pid, sessionId: eligible[0].sessionId }, reason: null }
  }
  if (eligible.length === 0) {
    return { agent: null, reason: 'no non-background holder carries this terminal id' }
  }
  return {
    agent: null,
    reason: `${eligible.length} candidate processes share this terminal id (${eligible
      .map((h) => h.pid)
      .join(', ')})`
  }
}
