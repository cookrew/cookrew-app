// WHO A CARD MAY BIND TO — the one filter every discovered session passes.
//
// THE INCIDENT (2026-09-06, the third defect behind the checkpoint-rail churn)
// ---------------------------------------------------------------------------
// At spawn and at reattach, `findExistingClaudeSession` chose a card's session
// by SCORING RECENT TRANSCRIPT FILES — prompt match first, mtime to break ties
// — and never asked the live claude processes what they were writing. A
// BACKGROUND JOB started from a terminal inherits that terminal's environment
// and writes its OWN transcript, which is recent and carries the same prompts,
// so the card adopted the JOB's session. Thirty seconds later the oracle sweep
// (claude-session-oracle.ts) rebound it to the session the pane's process
// actually reports, and the next spawn adopted the job again. Measured on
// Conductor: twenty lineage slots holding four distinct ids, 295d5f1c and
// a78aa3e5 alternating eight times, with `terminal.session-rotated` events in
// one direction only — the wrong adoption happened at SPAWN, never in the
// sweep. The rail jumped between two conversations and the history filled with
// churn.
//
// TWO RULES, AND WHY THEY LIVE HERE AND NOT AT A CALL SITE
// -------------------------------------------------------
//  1. A LIVE HOLDER OUTRANKS A FILE. The pane's own process states which
//     session it writes (~/.claude/sessions/<pid>.json). When it can be
//     identified — and a background holder never can be, per the pane-agent
//     rule — that statement is the answer and no directory is scored. The
//     oracle has judged rebinds this way since 2026-09-05; spawn was the last
//     path still guessing from mtimes.
//  2. A BACKGROUND HOLDER'S SESSION IS NEVER ADOPTED. Not as the best-scoring
//     file, not as an id baked into a launch command. The exclusion is a
//     property of the resolver, not a check a caller remembers to make, so a
//     future call site cannot reopen the defect.
//
// THE ONE EXEMPTION, NAMED ON PURPOSE: the id a card is ALREADY bound to. That
// is not an adoption, and refusing it would mint a fresh conversation over a
// real one. When a leftover `claude bg-spare` grabs a card's own session
// (Forge, claude-live-session.ts), the answer is planHeldSessionFork — resume
// from a COPY of the whole transcript and rebind to that copy — not amnesia.
//
// SCOPE — decisions over facts. The only side effect is reading claude's own
// live-process records, and a failed read means "cannot tell", never a throw.

import { liveSessionHolders, type SessionHolder } from './claude-live-session'
import { paneAgentOf } from '../shared/pane-agent.mjs'

/** What the resolver knows about live claude processes, all of it optional. */
export interface LiveClaudeView {
  /**
   * The pane's process, when the multiplexer ALREADY knows it. Never looked
   * up here: the lookup is a synchronous herdr child process, and a fleet
   * resolving at boot would pay for one each — the stall the oracle sweep
   * limits itself to one cold lookup per tick to avoid.
   */
  panePid?: number | null
  /** Every live claude process; read from claude's own records when absent. */
  holders?: readonly SessionHolder[]
}

/** Who may answer, and who may not — the whole rule, as data. */
export interface SessionAuthority {
  /** The session the pane's own process reports, or null when nothing can be said. */
  paneSession: string | null
  /** Sessions a background holder is writing. Never adoptable, by anyone. */
  refused: ReadonlySet<string>
}

/** Live records, or an empty set: "cannot tell" must behave as before. */
function readHolders(): readonly SessionHolder[] {
  try {
    return liveSessionHolders()
  } catch (error) {
    console.error('Live claude session records unreadable, resolving from files only:', error)
    return []
  }
}

/**
 * The live authority for a terminal in `cwd`.
 *
 * `real` resolves a cwd the way claude records it (realpath — macOS
 * /tmp -> /private/tmp); the identity default keeps this module free of fs so
 * it can be reasoned about and tested on its own.
 */
export function sessionAuthority(
  view: LiveClaudeView,
  cwd: string,
  real: (dir: string) => string = (dir) => dir
): SessionAuthority {
  const holders = view.holders ?? readHolders()
  const pane = paneAgentOf(view.panePid ?? null, holders, cwd, real)
  return {
    paneSession: pane?.sessionId ?? null,
    // Machine-wide, not scoped to this cwd: a background job may report a
    // different working directory than the pane that spawned it, and a session
    // some bg process is writing is the wrong answer for EVERY card.
    refused: new Set(holders.filter((h) => h.kind === 'bg').map((h) => h.sessionId))
  }
}

/** May a card bind to this session id? The whole of rule 2, in one place. */
export function mayAdopt(sessionId: string, authority: SessionAuthority): boolean {
  return !authority.refused.has(sessionId)
}
