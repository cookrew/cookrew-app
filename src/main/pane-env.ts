import path from 'node:path'

/**
 * THE ENVIRONMENT A PANE IS SPAWNED WITH — and the one line in it that is a
 * security boundary rather than a convenience.
 *
 * Extracted from PtySession's constructor so the boundary is testable: it is
 * asserted from a test rather than trusted from a reading of the constructor.
 */

export interface PaneEnvInput {
  terminalId: string
  /** The app's CLI command socket. Owner panes only — see below. */
  socketPath: string
  /** Directory holding the `cookrew` wrapper. Owner panes only. */
  cliDir: string
  /**
   * A served session's scrubbed env (session-env.ts), or absent for the
   * owner's own terminal. Its presence IS the "this pane works for a
   * stranger" fact.
   */
  servedEnv?: Readonly<Record<string, string>>
  /** The owner's sanitized process env, used when this is not a served pane. */
  ownerEnv: Readonly<Record<string, string | undefined>>
}

/**
 * Assemble it.
 *
 * THE CLI CONTROL PLANE IS THE OWNER'S ALONE. `COOKREW_SOCKET`, `COOKREW_CLI`
 * and cliDir-on-PATH hand a pane the app's unix socket, and that socket takes
 * commands with NO credential: `list --all` returns every agent in every
 * workspace, and `--as "<name>"` lets a caller with no pane identity speak AS
 * any agent (socket-server.ts self()). From a SERVED session that is a full
 * escape — `recruit --dir <owner dir> --command …` spawns a node with no
 * served spawn context, i.e. outside the sandbox, with the owner's
 * environment. The Seatbelt profile cannot stop it: it allows process-exec and
 * network* by design, and the socket lives in the shared runtime dir.
 *
 * A served session has no legitimate use for it either — its agents work for a
 * stranger, inside a sandbox, and must not see (let alone drive) the owner's
 * canvas. So these keys are OWNER-PANE ONLY, and session-sandbox.ts denies the
 * socket in the profile as the second lock.
 */
export function paneEnv(input: PaneEnvInput): Record<string, string> {
  const served = input.servedEnv !== undefined
  const base: Record<string, string> = served
    ? { ...input.servedEnv }
    : Object.fromEntries(
        Object.entries(input.ownerEnv).filter(([, value]) => value !== undefined)
      ) as Record<string, string>
  const infraPath = served ? (input.servedEnv?.PATH ?? '') : (input.ownerEnv.PATH ?? '')
  return {
    ...base,
    TERM_PROGRAM: 'Cookrew',
    COOKREW_TERMINAL_ID: input.terminalId,
    ...(served
      ? {}
      : {
          COOKREW_SOCKET: input.socketPath,
          COOKREW_CLI: path.join(input.cliDir, 'cookrew')
        }),
    PATH: served ? infraPath : `${input.cliDir}:${infraPath}`
  }
}
