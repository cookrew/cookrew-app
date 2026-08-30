/**
 * CALLER IDENTITY — who a `cookrew` CLI invocation is actually speaking as.
 *
 * `COOKREW_TERMINAL_ID` is exported into a pane's shell ONCE at boot
 * (herdr-host-multiplexer bootCommand) and never re-resolved. That is correct
 * for a pane's own agent, and it was measured correct for all 15 of them. It is
 * wrong for an agent the harness spawns in the BACKGROUND: such a session runs
 * under the process tree of whichever pane hosts the daemon, so it inherits
 * that pane's environment and every CLI call it makes is attributed to another
 * card — in another workspace — and SUCCEEDS. Both background sessions on the
 * author's machine were mis-attributed this way; the visible symptom was a
 * refused `browser create`, but a `note write` would simply have written to the
 * wrong workspace and reported OK.
 *
 * The app already holds the correct answer: every terminal node records the
 * claude session bound to it. A claude process knows its own session id — it is
 * in its argv — so the CLI can state it and the app can check the binding.
 *
 * The rule is one line: THE BINDING OUTRANKS THE ENVIRONMENT. Everything else
 * here exists to make that rule safe when the evidence is missing or partial.
 *
 * This is a correctness repair, not a security boundary. `cli/cookrew.mjs` says
 * so already: the socket is user-owned and anything running as this user could
 * always claim any identity. Nothing here is load-bearing against an attacker.
 */

/** A claude session id is a uuid; anything looser would let a stray flag win. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SESSION_FLAG = new RegExp(`--(?:session-id|resume)[= ](${UUID})\\b`, 'i')

/**
 * The claude session named by a command line, or null.
 *
 * `--resume` and `--session-id` are the same fact spelled differently: one
 * continues a session, the other opens it, and both mean "this process IS that
 * session". Matching only a full uuid is deliberate — a partial id would
 * resolve to nothing and a loose token could resolve to the wrong thing.
 */
export function sessionIdFromCommandLine(commandLine: string): string | null {
  const match = SESSION_FLAG.exec(commandLine)
  return match ? match[1].toLowerCase() : null
}

/** Just enough of a terminal node to answer the identity question. */
export interface IdentityTerminal {
  id: string
  claudeSessionId?: string | null
}

export interface CallerIdentityInput {
  /** What COOKREW_TERMINAL_ID claimed. May be empty (a plain shell). */
  envTerminalId: string
  /** The session the caller's own process tree says it is. May be null. */
  sessionId: string | null
  terminals: readonly IdentityTerminal[]
}

export interface CallerIdentity {
  terminalId: string
  /**
   * The env value that was overruled, or null when nothing was repaired.
   * Non-null is worth logging: it means a pane's environment is lying, and the
   * cases where that happens are the ones worth learning about.
   */
  repairedFrom: string | null
}

/**
 * Resolve the caller, preferring the session→node binding over the environment.
 *
 * Falls back to the environment — deliberately, not defensively — in every case
 * where the session is not EVIDENCE about identity:
 *
 *   no session supplied   a non-claude harness, or a CLI older than this change
 *   session unknown       measured: one live background session was bound to no
 *                         card at all, and an unbound session says nothing about
 *                         which card is speaking
 *
 * A node with no bound session can never be matched, or every unbound card
 * would answer to a null session.
 */
export function resolveCallerTerminalId(input: CallerIdentityInput): CallerIdentity {
  const { envTerminalId, sessionId } = input
  if (sessionId === null) return { terminalId: envTerminalId, repairedFrom: null }

  const bound = input.terminals.find(
    (terminal) =>
      typeof terminal.claudeSessionId === 'string' &&
      terminal.claudeSessionId.toLowerCase() === sessionId.toLowerCase()
  )
  if (!bound) return { terminalId: envTerminalId, repairedFrom: null }
  if (bound.id === envTerminalId) return { terminalId: bound.id, repairedFrom: null }
  return {
    terminalId: bound.id,
    // An empty env is not a repair — there was nothing to overrule.
    repairedFrom: envTerminalId.length > 0 ? envTerminalId : null
  }
}
