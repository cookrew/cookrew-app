/**
 * NO DEBUGGER INTO cookrewd.
 *
 * Electron in node mode (ELECTRON_RUN_AS_NODE) opens the Node inspector on
 * 127.0.0.1:9229 when it receives SIGUSR1, unauthenticated, and the app's
 * EnableNodeCliInspectArguments fuse does not cover that path (security
 * review 2026-11-16, verified). Every agent runs as the same user, so any of
 * them could `kill -USR1` the daemon, attach, and call the owner's handlers
 * or run code inside it. This module is imported first: it takes SIGUSR1 for
 * itself, and entry.ts refuses to boot if an inspector opened before it could
 * (the bundle's external packages load ahead of any of our code).
 */
import inspector from 'node:inspector'

process.on('SIGUSR1', () => {
  // Taken on purpose: with a listener, Node does not start the inspector.
})

const INSPECT_FLAG = /--(inspect|inspect-brk|inspect-port|inspect-publish-uid|debug-port)\b/

/** Why the daemon must not run as it was started (an inspector open or asked for); empty when fine. */
export function inspectorProblems(input: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly execArgv: readonly string[]
  readonly inspectorUrl: string | undefined
}): readonly string[] {
  const problems: string[] = []
  if (input.inspectorUrl !== undefined) problems.push('a Node inspector is open on this process')
  if (input.execArgv.some((arg) => INSPECT_FLAG.test(arg))) problems.push('the process was started with an inspector flag')
  if (INSPECT_FLAG.test(input.env.NODE_OPTIONS ?? '')) problems.push('NODE_OPTIONS asks for an inspector')
  return problems
}

/** The live answer for this process. */
export const currentInspectorProblems = (): readonly string[] =>
  inspectorProblems({ env: process.env, execArgv: process.execArgv, inspectorUrl: inspector.url() })
